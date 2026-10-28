import { connectionString, integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { randomUUID } from "node:crypto";

import { createAuthorityDatabase, databaseFailureEvidence } from "../dist/index.js";


integration("a real driver read timeout destroys its pooled connection without a rollback deadline", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  let pool;
  const observations = [];
  const database = createAuthorityDatabase({
    connectionString, shardId: "shard-0", statementTimeoutMs: 300,
    observer: (point) => observations.push(point),
    poolFactory: (config) => { pool = new Pool(config); return pool; },
  });
  await assert.rejects(database.transaction({
    requestId: "driver-timeout-regression", operation: "read",
  }, async (transaction) => {
    // Exercise the client deadline independently of the server's SQLSTATE
    // timeout. This transaction changes only its own local setting.
    await transaction.query({ name: "test_server_deadline_v1",
      text: "SELECT set_config('statement_timeout', '2000', true)", maxRows: 1 });
    await transaction.query({ name: "test_stalled_response_v1",
      text: "SELECT pg_sleep(1)", maxRows: 1 });
  }), /Query read timeout/u);
  assert.equal(pool.totalCount, 0, "the timed-out checkout must leave the pool");
  assert.equal(observations.find((point) => point.queryName === "test_stalled_response_v1")?.errorCode,
    "QUERY_READ_TIMEOUT");
  assert.equal(observations.some((point) => point.queryName === "database_phase_rollback_v1"), false);
});

integration("one opening message begins the transaction with every setting intact", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  const requestId = "it's a \\ request; SELECT 1; --";
  const rows = await database.transaction({
    requestId, operation: "client.opening", isolation: "serializable",
  }, (transaction) => transaction.query({ name: "test_opening_settings_v1", text: `SELECT
      current_setting('xmatrix.request_id') AS request_id,
      current_setting('xmatrix.operation') AS operation,
      current_setting('transaction_isolation') AS isolation,
      current_setting('lock_timeout') AS lock_timeout`, maxRows: 1 }));
  assert.deepEqual(rows, [{ request_id: requestId, operation: "client.opening",
    isolation: "serializable", lock_timeout: "2s" }]);
});

// HUB-AY: a lock timeout erases pg_blocking_pids' wait edge. Existing driver
// recovery tests cannot prove the diagnostic was taken while the SQL was waiting.
integration("execution-owner lock failures retain the live blocker without identities or SQL", async () => {
  const isolated = await isolatedPostgres("execution_lock", { migrate: false, runtimeRole: false });
  const connectionString = isolated.url.toString();
  const placement = { spaceId: "space", shardId: "lock-diagnostic", placementEpoch: 1 };
  const holder = new Client({ connectionString });
  const table = `execution_wait_${randomUUID().replaceAll("-", "")}`;
  await holder.connect();
  try {
    await holder.query(`CREATE SCHEMA control;
      CREATE TABLE control.space_placement (space_id text,shard_id text,placement_epoch int,state text,target_shard_id text);
      INSERT INTO control.space_placement VALUES ('space','lock-diagnostic',1,'active',NULL)`);
    await holder.query(`CREATE TABLE ${table} (id int PRIMARY KEY, private_value text)`);
    await holder.query(`INSERT INTO ${table} VALUES (1,'private-report')`);
    await holder.query("BEGIN; SET LOCAL application_name='xmatrix-execution-report'");
    await holder.query(`SELECT * FROM ${table} FOR UPDATE`);
    for (const unavailable of [false, true]) {
      let diagnosticConnections = 0;
      const database = createAuthorityDatabase({ connectionString, shardId: "lock-diagnostic",
        lockTimeoutMs: 1500, clientFactory: config => {
          // A real driver owns the command. Only the independent diagnostic
          // connection is unavailable in the negative case.
          if (config.application_name === "xmatrix-lock-diagnostic") {
            diagnosticConnections++;
            if (unavailable) throw new Error("private-diagnostic-failure");
          }
          return new Client(config);
        } });
      await assert.rejects(database.transaction({ requestId: "private-request",
        operation: "runtime.execution-report", placement }, tx => tx.query({ name: "runtime_execution_report_owner_v4",
        text: `SELECT private_value FROM ${table} WHERE id=$1 FOR UPDATE`, values: [1], maxRows: 1 })), error => {
        assert.equal(error.code, "55P03", "the original failure remains authoritative");
        const [evidence] = databaseFailureEvidence(error);
        assert.equal(evidence.lockWait?.status, unavailable ? "unavailable" : "sampled");
        if (!unavailable) {
          assert.equal(evidence.lockWait.waiter.owner, "execution-report");
          assert.equal(evidence.lockWait.waiter.wait, "Lock");
          assert.equal(evidence.lockWait.blockers.length, 1);
          assert.equal(evidence.lockWait.blockers[0].owner, "execution-report");
          assert.equal(evidence.lockWait.blockers[0].state, "idle in transaction");
          assert.ok(evidence.lockWait.blockers[0].ageMs >= 1);
        }
        assert.doesNotMatch(JSON.stringify(evidence), /private-|execution_wait_|backend_pid|SELECT|password/u);
        return true;
      });
      assert.equal(diagnosticConnections, 1);
    }
    let samples = 0;
    const concurrent = createAuthorityDatabase({ connectionString, shardId: "lock-diagnostic",
      lockTimeoutMs: 1500, clientFactory: config => {
        const client = new Client(config);
        if (config.application_name !== "xmatrix-lock-diagnostic") return client;
        samples++;
        return { async connect() {
          await client.connect();
          await client.query("SELECT pg_sleep(0.15)");
        }, query: client.query.bind(client), end: client.end.bind(client) };
      } });
    const failures = await Promise.allSettled([1, 2].map(index => concurrent.transaction({
      requestId: `concurrent-${index}`, operation: "runtime.execution-report", placement,
    }, tx => tx.query({ name: "runtime_execution_report_owner_v4", text: `SELECT id FROM ${table} FOR UPDATE`, maxRows: 1 }))));
    assert.ok(failures.every(result => result.status === "rejected" && result.reason.code === "55P03"));
    assert.deepEqual(failures.map(result => databaseFailureEvidence(result.reason)[0].lockWait.status).sort(), ["busy", "sampled"]);
    assert.equal(samples, 1, "concurrent waiting reports share the isolate's one diagnostic slot");
    await holder.query("ROLLBACK");
    const database = createAuthorityDatabase({ connectionString, shardId: "lock-diagnostic",
      clientFactory: config => {
        assert.notEqual(config.application_name, "xmatrix-lock-diagnostic", "a fast query opens no diagnostic connection");
        return new Client(config);
      } });
    assert.deepEqual(await database.transaction({ requestId: "fast", operation: "runtime.execution-report", placement },
      tx => tx.query({ name: "runtime_execution_report_owner_v4", text: "SELECT 1 AS ok", maxRows: 1 })), [{ ok: 1 }]);
  } finally {
    await holder.query("ROLLBACK");
    await holder.query(`DROP TABLE ${table}`);
    await holder.end();
    await isolated.close();
  }
});

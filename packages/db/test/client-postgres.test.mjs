import { connectionString, integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { randomUUID } from "node:crypto";

import { createAuthorityDatabase, databaseFailureEvidence, PostgresSpacePlacementDirectory } from "../dist/index.js";
import { lockAgentRunChannels } from "../dist/agent-channel-access.js";


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
  const holder = isolated.client;
  const table = `execution_wait_${randomUUID().replaceAll("-", "")}`;
  try {
    await holder.query(`CREATE SCHEMA control;
      CREATE TABLE control.space_placement (space_id text,shard_id text,placement_epoch int,state text,target_shard_id text);
      INSERT INTO control.space_placement VALUES ('space','lock-diagnostic',1,'active',NULL)`);
    await holder.query(`CREATE TABLE ${table} (id int PRIMARY KEY, private_value text)`);
    await holder.query(`INSERT INTO ${table} VALUES (1,'private-report')`);
    await holder.query("BEGIN; SET LOCAL application_name='xmatrix-execution-report'");
    await holder.query(`SELECT * FROM ${table} FOR UPDATE`);
    for (const mode of ["available", "unavailable", "disconnect"]) {
      let diagnosticConnections = 0;
      const database = createAuthorityDatabase({ connectionString, shardId: "lock-diagnostic",
        lockTimeoutMs: 1500, clientFactory: config => {
          // A real driver owns the command. Only the independent diagnostic
          // connection is unavailable in the negative case.
          if (config.application_name === "xmatrix-lock-diagnostic") {
            diagnosticConnections++;
            if (mode === "unavailable") throw new Error("private-diagnostic-failure");
            if (mode === "disconnect") {
              const client = new Client(config);
              return { on: client.on.bind(client), connect: client.connect.bind(client),
                query: () => client.query("SELECT pg_terminate_backend(pg_backend_pid())"), end: client.end.bind(client) };
            }
          }
          return new Client(config);
        } });
      await assert.rejects(database.transaction({ requestId: "private-request",
        operation: "runtime.execution-report", placement }, tx => tx.query({ name: "runtime_execution_report_owner_v4",
        text: `SELECT private_value FROM ${table} WHERE id=$1 FOR UPDATE`, values: [1], maxRows: 1 })), error => {
        assert.equal(error.code, "55P03", "the original failure remains authoritative");
        const [evidence] = databaseFailureEvidence(error);
        assert.equal(evidence.lockWait?.status, mode === "available" ? "sampled" : "unavailable");
        if (mode === "available") {
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
    let readyCount = 0, releaseReady;
    const ready = new Promise(resolve => { releaseReady = resolve; });
    const failures = await Promise.allSettled([1, 2].map(index => concurrent.transaction({
      requestId: `concurrent-${index}`, operation: "runtime.execution-report", placement,
    }, async tx => {
      if (++readyCount === 2) releaseReady();
      await ready;
      return tx.query({ name: "runtime_execution_report_owner_v4", text: `SELECT id FROM ${table} FOR UPDATE`, maxRows: 1 });
    })));
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
    try { await holder.query("ROLLBACK"); }
    finally { await isolated.close(); }
  }
});

// HUB-AZ waits on the Channel before locking a Run. The execution-owner test
// never enters this shared lifecycle lock, so it missed this diagnostic gap.
integration("Agent message Channel lock failures retain either Channel's live blocker", async () => {
  const isolated = await isolatedPostgres("channel_lock", { migrate: false, runtimeRole: false });
  const holder = isolated.client;
  let samples = 0;
  const database = createAuthorityDatabase({ connectionString: isolated.url.toString(), shardId: "shard-0",
    applicationName: "xmatrix-hub-message-authority", lockTimeoutMs: 1500,
    clientFactory: config => {
      if (config.application_name === "xmatrix-lock-diagnostic") samples++;
      return new Client(config);
    } });
  try {
    await holder.query("CREATE SCHEMA data; CREATE TABLE data.channels (channel_id text PRIMARY KEY)");
    await holder.query("INSERT INTO data.channels VALUES ('private-a'),('private-b')");
    for (const channel of ["private-a", "private-b"]) {
      await holder.query("BEGIN; SET LOCAL application_name='xmatrix-agent-launch-coordinator'");
      await holder.query("SELECT 1 FROM data.channels WHERE channel_id=$1 FOR UPDATE", [channel]);
      await assert.rejects(database.transaction({ requestId: "private-request", operation: "message.append" },
        tx => lockAgentRunChannels(tx, "private-b", "private-a")), error => {
        assert.equal(error.code, "55P03");
        const [evidence] = databaseFailureEvidence(error);
        assert.equal(evidence.queryName, "channel_lifecycle_lock_runtime_new_work_v1");
        assert.equal(evidence.lockWait?.status, "sampled");
        assert.equal(evidence.lockWait.waiter.owner, "message");
        assert.equal(evidence.lockWait.waiter.wait, "Lock");
        assert.equal(evidence.lockWait.blockers[0].owner, "launch");
        assert.equal(evidence.lockWait.blockers[0].state, "idle in transaction");
        assert.ok(evidence.lockWait.blockers[0].ageMs >= 1);
        assert.doesNotMatch(JSON.stringify(evidence), /private-|SELECT|postgres:\/\//u);
        return true;
      });
      await holder.query("ROLLBACK");
    }
    assert.equal(samples, 2, "each failed Channel wait samples once");
    await database.transaction({ requestId: "fast", operation: "message.append" },
      tx => lockAgentRunChannels(tx, "private-b", "private-a"));
    assert.equal(samples, 2, "uncontended Channel locks open no diagnostic connection");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});

// HUB-B1 already retries safely. The missing contract is observing this exact
// single-read attempt without a transaction-scoped backend PID; lock-owner
// tests never exercise the transaction-pool lookup or the retry's new marker.
integration("placement read timeouts retain each attempt's live origin wait without private data", async () => {
  const isolated = await isolatedPostgres("placement_wait", { migrate: false, runtimeRole: false });
  const holder = isolated.client;
  const connectionString = isolated.url.toString();
  try {
    await holder.query(`CREATE SCHEMA control;
      CREATE TABLE control.space_placement (space_id text PRIMARY KEY,shard_id text,placement_epoch int,
        state text,target_shard_id text,plan_class text);
      INSERT INTO control.space_placement VALUES ('private-space','shard-0',1,'active',NULL,'free')`);
    await holder.query("BEGIN; SET LOCAL application_name='xmatrix-agent-launch-coordinator'");
    await holder.query("LOCK control.space_placement IN ACCESS EXCLUSIVE MODE");
    for (const mode of ["available", "unavailable", "missing"]) {
      let samples = 0;
      const prefixes = [];
      const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
        statementTimeoutMs: 1300, lockTimeoutMs: 2000, clientFactory: config => {
          if (config.application_name === "xmatrix-lock-diagnostic") {
            samples++;
            if (mode === "unavailable") throw new Error("private-diagnostic");
          }
          const client = new Client(config);
          return { on: client.on.bind(client), connect: client.connect.bind(client),
            async query(input) {
              if (config.application_name === "xmatrix-lock-diagnostic") {
                prefixes.push(input.values[0]);
                if (mode === "missing") {
                  // A real query with no matching backend, not invented evidence.
                  return client.query({ ...input, values: ["/* absent-at-origin */"] });
                }
              }
              return client.query(input);
            }, end: client.end.bind(client) };
        } });
      await assert.rejects(new PostgresSpacePlacementDirectory(database).read({
        requestId: "private-request", operation: "page.links",
      }, "private-space"), error => {
        assert.match(error.message, /Query read timeout/);
        const attempts = databaseFailureEvidence(error);
        assert.equal(attempts.length, 2, "the original one-retry boundary stays intact");
        for (const attempt of attempts) {
          assert.equal(attempt.queryWait?.status, mode === "available" ? "sampled" : mode);
          if (mode === "available") {
            assert.equal(attempt.queryWait.waiter.state, "active");
            assert.equal(attempt.queryWait.waiter.wait, "Lock");
            assert.equal(attempt.queryWait.blockers[0].owner, "launch");
          }
        }
        assert.doesNotMatch(JSON.stringify(attempts), /private-|SELECT|xmatrix-read-|postgres:\/\//);
        return true;
      });
      assert.equal(samples, 2);
      if (mode !== "unavailable") assert.equal(new Set(prefixes).size, 2, "retry has its own correlation");
    }
    await holder.query("ROLLBACK");
    const database = createAuthorityDatabase({ connectionString, shardId: "shard-0", clientFactory: config => {
      assert.notEqual(config.application_name, "xmatrix-lock-diagnostic", "fast placement reads need no extra connection");
      return new Client(config);
    } });
    assert.equal((await new PostgresSpacePlacementDirectory(database).read({ requestId: "fast",
      operation: "page.links" }, "private-space")).spaceId, "private-space");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});
// HUB-B0: placement-read coverage does not protect the Channel catalog's
// separate query selection, including a retry and its implicit placement lock.
integration("single-read timeouts retain each attempt's live source activity without private data", async () => {
  const isolated = await isolatedPostgres("read_activity", { migrate: false, runtimeRole: false });
  let samples = 0;
  const database = createAuthorityDatabase({ connectionString: isolated.url.toString(), shardId: "read-activity",
    statementTimeoutMs: 1000, clientFactory: config => {
      if (config.application_name === "xmatrix-lock-diagnostic") samples++;
      return new Client(config);
    } });
  try {
    await assert.rejects(database.transaction({ requestId: "private-request", operation: "channel-catalog.page",
      statement: "single_read" }, tx => tx.query({ name: "channel_catalog_page_flat_all_v14",
      text: "SELECT pg_sleep(1.5),$1::text AS private_value", values: ["private-parameter"], maxRows: 1 })), error => {
      assert.match(error.message, /Query read timeout/u);
      const attempts = databaseFailureEvidence(error);
      assert.equal(attempts.length, 2, "the existing fresh-connection retry stays bounded");
      for (const attempt of attempts) {
        assert.equal(attempt.code, "QUERY_READ_TIMEOUT");
        assert.equal(attempt.queryWait?.status, "sampled");
        assert.equal(attempt.queryWait.waiter.state, "active");
        assert.equal(attempt.queryWait.waiter.wait, "Timeout");
        assert.ok(attempt.queryWait.waiter.ageMs < 1000, "each sample identifies its own attempt");
        assert.deepEqual(attempt.queryWait.blockers, []);
      }
      assert.doesNotMatch(JSON.stringify(attempts), /private-|SELECT|pg_sleep|xmatrix-read|postgres:\/\//u);
      return true;
    });
    assert.equal(samples, 2);
    const fast = createAuthorityDatabase({ connectionString: isolated.url.toString(), shardId: "read-fast",
      clientFactory: config => {
        assert.notEqual(config.application_name, "xmatrix-lock-diagnostic");
        return new Client(config);
      } });
    assert.deepEqual(await fast.transaction({ requestId: "fast", operation: "page.links", statement: "single_read" },
      tx => tx.query({ name: "space_placement_resolve_v1", text: "SELECT 1 AS ok", maxRows: 1 })), [{ ok: 1 }]);
  } finally { await isolated.close(); }
});

integration("single-read placement waits retain their blocker and tolerate unavailable diagnostics", async () => {
  const isolated = await isolatedPostgres("read_fence_wait", { migrate: false, runtimeRole: false });
  const placement = { spaceId: "private-space", shardId: "read-fence", placementEpoch: 1 };
  const holder = isolated.client;
  try {
    await holder.query(`CREATE SCHEMA control;
      CREATE TABLE control.space_placement (space_id text,shard_id text,placement_epoch int,state text,target_shard_id text);
      INSERT INTO control.space_placement VALUES ('private-space','read-fence',1,'active',NULL)`);
    await holder.query("BEGIN; SET LOCAL application_name='xmatrix-agent-launch-coordinator'");
    await holder.query("SELECT * FROM control.space_placement FOR UPDATE");
    for (const available of [true, false]) {
      let samples = 0;
      const database = createAuthorityDatabase({ connectionString: isolated.url.toString(), shardId: placement.shardId,
        lockTimeoutMs: 1500, clientFactory: config => {
          if (config.application_name === "xmatrix-lock-diagnostic") {
            samples++;
            if (!available) throw new Error("private-diagnostic-failure");
          }
          return new Client(config);
        } });
      await assert.rejects(database.transaction({ requestId: "private-request", operation: "channel-catalog.page",
        statement: "single_read", placement }, tx => tx.query({ name: "channel_catalog_page_flat_all_v14",
        text: "SELECT 1 AS ok", maxRows: 1 })), error => {
        assert.equal(error.code, "55P03");
        const attempts = databaseFailureEvidence(error);
        assert.equal(attempts.length, 1, "an answered lock timeout is not replayed");
        assert.equal(attempts[0].queryWait?.status, available ? "sampled" : "unavailable");
        if (available) {
          assert.equal(attempts[0].queryWait.waiter.wait, "Lock");
          assert.equal(attempts[0].queryWait.blockers[0].owner, "launch");
        }
        assert.doesNotMatch(JSON.stringify(attempts), /private-|SELECT|xmatrix-read|postgres:\/\//u);
        return true;
      });
      assert.equal(samples, 1);
    }
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});

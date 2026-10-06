import { connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Pool } from "pg";

import { createAuthorityDatabase } from "../dist/index.js";


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

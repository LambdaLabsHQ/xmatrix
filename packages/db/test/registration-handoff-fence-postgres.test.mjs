import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { HANDOFF_SOURCE_FENCE_SQL } from "../dist/registration-reborn.js";


// Every handoff successor is created through this fence. Its parameters reach
// Postgres untyped, as from the Worker driver: a text-typed timestamp assigned
// to `updated_at` failed every handoff with 42804 and left it waiting a day.
integration("a handoff fences its predecessor with the transfer time as the row's timestamp", async () => {
  assert.ok(url);
  const schema = `handoff_fence_${process.pid}`;
  const client = new Client({ connectionString: url }); await client.connect();
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    // The columns the fence reads and writes, with their production types.
    await client.query(rewrite(`CREATE TABLE data.runs (run_id text PRIMARY KEY,version bigint NOT NULL,
        metadata_json jsonb NOT NULL,updated_at timestamptz NOT NULL);
      CREATE TABLE data.instances (instance_id text PRIMARY KEY,run_id text NOT NULL,channel_id text NOT NULL)`));
    const created = "2026-10-02T19:00:00.000Z", at = "2026-10-02T19:31:18.326Z";
    await client.query(rewrite(`INSERT INTO data.runs VALUES ('run-1',1,'{}'::jsonb,$1)`), [created]);
    await client.query(rewrite(`INSERT INTO data.instances VALUES ('instance-1','run-1','channel')`));
    const fence = () => client.query(rewrite(HANDOFF_SOURCE_FENCE_SQL), ["instance-2", "message-1", at, "instance-1", "channel"]);
    assert.deepEqual((await fence()).rows, [{ run_id: "run-1" }]);
    const run = (await client.query(rewrite(`SELECT version,updated_at,metadata_json FROM data.runs WHERE run_id='run-1'`))).rows[0];
    assert.equal(Number(run.version), 2);
    assert.equal(run.updated_at.toISOString(), at);
    assert.deepEqual(run.metadata_json.instanceHandoff, { schemaVersion: 1, instanceId: "instance-1", runId: "run-1",
      successorInstanceId: "instance-2", sourceMessageId: "message-1", reason: "Handoff", transferredAt: at });
    assert.deepEqual((await fence()).rows, [], "a predecessor is handed off once");
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

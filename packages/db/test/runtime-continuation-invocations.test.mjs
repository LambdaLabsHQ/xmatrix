import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const url = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = url || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true" ? test : test.skip;

const sourceUrl = new URL("../src/runtime-control.ts", import.meta.url);

async function continuationQuery() {
  const source = await readFile(sourceUrl, "utf8");
  const marker = 'name: "runtime_continuation_invocations_v4", text: `';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "continuation query v4");
  const sqlStart = start + marker.length;
  return { sql: source.slice(sqlStart, source.indexOf("`", sqlStart)) };
}

integration("handoff from cursor to grok shows grok, and a reborn stays on its own registration", async () => {
  assert.ok(url);
  const { default: pg } = await import("pg");
  const { sql } = await continuationQuery();
  const schema = `continuation_chip_${process.pid}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const rewrite = text => text.replaceAll("data.", `${schema}.`);
  const at = "2026-10-05T08:46:00.000Z";
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(rewrite(`CREATE TABLE data.agent_reborn_intents (
        successor_run_id text PRIMARY KEY, channel_id text NOT NULL, space_id text NOT NULL,
        source_run_id text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        state text NOT NULL, stop_required boolean NOT NULL, error_code text, run_input_json jsonb NOT NULL);
      CREATE TABLE data.runs (run_id text PRIMARY KEY, channel_id text NOT NULL, created_at timestamptz NOT NULL,
        status text NOT NULL, updated_at timestamptz NOT NULL, finished_at timestamptz, metadata_json jsonb,
        invocation_source_json jsonb);
      CREATE TABLE data.run_agent_registrations (run_id text PRIMARY KEY, space_id text NOT NULL,
        owner_user_id text NOT NULL, machine_id text NOT NULL, harness text NOT NULL);
      CREATE TABLE data.space_agent_registrations (space_id text NOT NULL, owner_user_id text NOT NULL,
        machine_id text NOT NULL, harness text NOT NULL, display_name text NOT NULL,
        PRIMARY KEY (space_id, owner_user_id, machine_id, harness));
      CREATE TABLE data.messages (space_id text NOT NULL, channel_id text NOT NULL, message_id text NOT NULL,
        entity_version bigint NOT NULL, invocation_input_version bigint, body_hash text, author_kind text,
        author_id text, deleted_at timestamptz, recalled_at timestamptz);
      CREATE TABLE data.instances (instance_id text PRIMARY KEY, run_id text NOT NULL UNIQUE, status text NOT NULL);
      CREATE TABLE data.agent_launches (run_id text PRIMARY KEY)`));
    await client.query(rewrite(`INSERT INTO data.space_agent_registrations VALUES
        ('space-1','owner-1','machine-1','cursor','cursor'),
        ('space-1','owner-1','machine-1','grok','grok')`));
    await client.query(rewrite(`INSERT INTO data.messages
        (space_id,channel_id,message_id,entity_version,invocation_input_version) VALUES
        ('space-1','channel-1','message-handoff',1,1),
        ('space-1','channel-1','message-reborn',1,1)`));
    await client.query(rewrite(`INSERT INTO data.runs
        (run_id,channel_id,created_at,status,updated_at,metadata_json) VALUES
        ('run-cursor','channel-1',$1,'stopped',$1,'{"instanceHandoff":{"schemaVersion":1}}'::jsonb),
        ('run-grok','channel-1',$1,'running',$1,'{}'::jsonb),
        ('run-reborn-source','channel-1',$1,'stopped',$1,'{}'::jsonb),
        ('run-reborn','channel-1',$1,'running',$1,'{}'::jsonb)`), [at]);
    await client.query(rewrite(`INSERT INTO data.run_agent_registrations VALUES
        ('run-cursor','space-1','owner-1','machine-1','cursor'),
        ('run-reborn-source','space-1','owner-1','machine-1','cursor')`));
    await client.query(rewrite(`INSERT INTO data.instances VALUES
        ('instance-cursor','run-cursor','offline'),
        ('instance-grok','run-grok','online'),
        ('instance-reborn','run-reborn','idle')`));
    const handoff = {
      registration: { key: { spaceId: "space-1", ownerUserId: "owner-1", machineId: "machine-1", harness: "grok" } },
      metadata: { agentName: "old-grok" },
      invocationSource: { kind: "handoff", sourceMessageId: "message-handoff", sourceMessageVersion: 1,
        sourceName: "cursor", sourceInstanceId: "instance-cursor", targetInstanceId: "instance-grok" },
    };
    const reborn = {
      registration: { key: { spaceId: "space-1", ownerUserId: "owner-1", machineId: "machine-1", harness: "cursor" } },
      metadata: { agentName: "cursor" },
      invocationSource: { kind: "reborn", sourceMessageId: "message-reborn", sourceMessageVersion: 1,
        sourceName: "cursor", sourceInstanceId: "instance-reborn", targetInstanceId: "instance-reborn" },
    };
    await client.query(rewrite(`INSERT INTO data.agent_reborn_intents
        (successor_run_id,channel_id,space_id,source_run_id,created_at,updated_at,state,stop_required,run_input_json)
        VALUES ('run-grok','channel-1','space-1','run-cursor',$1,$1,'prepared',false,$2::jsonb),
               ('run-reborn','channel-1','space-1','run-reborn-source',$1,$1,'prepared',false,$3::jsonb)`),
      [at, JSON.stringify(handoff), JSON.stringify(reborn)]);
    const rows = (await client.query(rewrite(sql), ["channel-1", ["message-handoff", "message-reborn"], null, null, null, 10, "space-1"])).rows;
    const byRun = Object.fromEntries(rows.map(row => [row.run_id, row]));
    assert.equal(byRun["run-grok"].target_name, "grok");
    assert.equal(byRun["run-grok"].target_runtime, "grok");
    assert.equal(byRun["run-grok"].instance_status, "online");
    assert.equal(byRun["run-reborn"].target_name, "cursor");
    assert.equal(byRun["run-reborn"].target_runtime, "cursor");
    assert.equal(byRun["run-reborn"].instance_status, "idle");
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

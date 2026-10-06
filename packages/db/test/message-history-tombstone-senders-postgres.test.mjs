import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { hydrateTombstoneSenders } from "../dist/message-history-tombstone-senders.js";


integration("recalled rows are named by their Space author; live rows and other Spaces are untouched", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url }); await client.connect();
  const schema = `tombstone_senders_${process.pid}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,display_name text,avatar_url text)`);
    await client.query(`CREATE TABLE ${schema}.instances (instance_id text,run_id text,channel_instance_id bigint)`);
    await client.query(`CREATE TABLE ${schema}.run_agent_registrations
      (run_id text PRIMARY KEY,space_id text,owner_user_id text,machine_id text,harness text)`);
    await client.query(`CREATE TABLE ${schema}.space_agent_registrations
      (space_id text,owner_user_id text,machine_id text,harness text,display_name text)`);
    await client.query(`INSERT INTO ${schema}.space_members VALUES
      ('space','human','Yiming Hu','/a.png'),('other','outsider','Elsewhere',NULL)`);
    await client.query(`INSERT INTO ${schema}.instances VALUES ('birth:8','run-8',8),('far:2','run-far',2)`);
    await client.query(`INSERT INTO ${schema}.run_agent_registrations VALUES
      ('run-8','space','human','m','claude'),('run-far','other','outsider','m','codex')`);
    await client.query(`INSERT INTO ${schema}.space_agent_registrations VALUES
      ('space','human','m','claude','claude'),('other','outsider','m','codex','codex')`);
    const tx = { query: async ({ text, values, maxRows }) => {
      const { rows } = await client.query(text.replaceAll("data.", `${schema}.`), values);
      assert.ok(rows.length <= maxRows);
      return rows;
    } };
    const rows = [
      { author_kind: "user", author_id: "human", payload_bundle_base64: null },
      { author_kind: "agent", author_id: "birth:8", payload_bundle_base64: null },
      { author_kind: "agent", author_id: "birth:8", payload_bundle_base64: null },
      { author_kind: "user", author_id: "human", payload_bundle_base64: "live" },
      { author_kind: "user", author_id: "outsider", payload_bundle_base64: null },
      { author_kind: "agent", author_id: "far:2", payload_bundle_base64: null },
      { author_kind: "app", author_id: "github", payload_bundle_base64: null },
    ];
    await hydrateTombstoneSenders(tx, "space", rows);
    assert.deepEqual(rows[0].tombstone_sender,
      { label: "Yiming Hu", name: "Yiming Hu", userId: "human", avatarUrl: "/a.png" });
    assert.deepEqual(rows[1].tombstone_sender, { label: "claude:8", name: "claude", agentName: "claude",
      instanceId: "birth:8", channelInstanceId: "8", instanceLabel: "claude:8" });
    assert.deepEqual(rows[2].tombstone_sender, rows[1].tombstone_sender);
    for (const row of rows.slice(3)) assert.equal(row.tombstone_sender, undefined, row.author_id);
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

test("a page with no tombstones issues no query", async () => {
  await hydrateTombstoneSenders({ query: async () => assert.fail("unexpected query") }, "space",
    [{ author_kind: "user", author_id: "human", payload_bundle_base64: "live" }]);
});

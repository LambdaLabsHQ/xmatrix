import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { atomicAttentionTargets } from "../dist/message-attention-targets.js";


integration("repeated Agent labels resolve by authorized Channel ordinal before name ambiguity", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url }); await client.connect();
  const schema = `instance_attention_${process.pid}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.channels (channel_id text,space_id text,mode text,metadata_json jsonb)`);
    await client.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,role text,display_name text)`);
    await client.query(`CREATE TABLE ${schema}.auth_users (id text,name text,handle text)`);
    await client.query(`CREATE TABLE ${schema}.channel_access (space_id text,channel_id text,subject_kind text,subject_id text)`);
    await client.query(`CREATE TABLE ${schema}.agent_profiles
      (space_id text,owner_user_id text,name text,display_name text,name_key text)`);
    await client.query(`CREATE TABLE ${schema}.runs (run_id text,channel_id text)`);
    await client.query(`CREATE TABLE ${schema}.instances (instance_id text,run_id text,channel_id text,channel_instance_id bigint,
      UNIQUE (channel_id,channel_instance_id))`);
    await client.query(`INSERT INTO ${schema}.channels VALUES ('channel','space','open','{}'),('other','space','open','{}')`);
    await client.query(`INSERT INTO ${schema}.space_members VALUES ('space','human','owner','Human')`);
    await client.query(`INSERT INTO ${schema}.agent_profiles VALUES
      ('profile-a','space','human','old-a','claude','old-a'),('profile-b','space','human','old-b','claude','old-b')`);
    await client.query(`INSERT INTO ${schema}.runs VALUES ('run-a','profile-a','channel'),('run-b','profile-b','channel'),('run-other','profile-b','other')`);
    await client.query(`INSERT INTO ${schema}.instances VALUES ('i-a','run-a','channel',2),('i-b','run-b','channel',3),('i-other','run-other','other',9)`);
    const tx = { query: async ({ text, values, maxRows }) => {
      const { rows } = await client.query(text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`), values);
      assert.ok(rows.length <= maxRows);
      return rows;
    } };
    const resolve = body => atomicAttentionTargets(tx, { spaceId: "space", channelId: "channel", body, senderSubjectId: "user:human" });
    for (const body of ["@claude:2 reply", "@claude:2:reborn", "@claude:2:stop", "@claude:2:kill", "@old-a:2 reply", "@profile-a:2 reply"]) {
      assert.deepEqual([...await resolve(body)], [["agent:profile-a", "mention"]], body);
    }
    assert.deepEqual([...await resolve("@claude:3 reply")], [["agent:profile-b", "mention"]]);
    for (const body of ["@claude:9 reply", "@profile-a:3 reply", "@claude:99:reborn", "`@claude:2`", "> @claude:2", "\\@claude:2"]) {
      assert.deepEqual([...await resolve(body)], [], body);
    }
    assert.deepEqual([...await resolve("@claude reply")], []);
    assert.deepEqual([...await resolve("@claude:new:owner/repo")], []);
    await client.query(`UPDATE ${schema}.channels SET mode='closed' WHERE channel_id='channel'`);
    assert.deepEqual([...await resolve("@claude:2 reply")], [], "ordinal must not bypass current Channel access");
    await client.query(`INSERT INTO ${schema}.channel_access VALUES ('space','channel','agent','profile-a')`);
    assert.deepEqual([...await resolve("@claude:2 reply")], [["agent:profile-a", "mention"]]);
    assert.deepEqual([...await resolve("@claude:3 reply")], []);
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

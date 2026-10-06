import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { authorizeMessageInvocationSelections, bodyWithoutInvocationSelections,
  readMessageInvocationSelections } from "../dist/message-invocation-selections.js";


integration("structured message targets bind exact text and current Space authority without name resolution", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url }); await client.connect();
  const schema = `invocation_selection_${process.pid}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    const sql = text => text.replaceAll("data.", `${schema}.`);
    const tx = { query: async ({ text, values, maxRows }) => {
      const { rows } = await client.query(sql(text), values); assert.ok(rows.length <= maxRows); return rows;
    } };
    await client.query(`CREATE TABLE ${schema}.agent_registration_authority (space_id text,mode text)`);
    await client.query(`CREATE TABLE ${schema}.channels
      (channel_id text,space_id text,mode text,metadata_json jsonb,version bigint,archived_at timestamptz)`);
    await client.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,role text)`);
    await client.query(`CREATE TABLE ${schema}.channel_access
      (channel_id text,space_id text,subject_kind text,subject_id text)`);
    await client.query(`CREATE TABLE ${schema}.space_agent_registrations
      (space_id text,owner_user_id text,machine_id text,harness text,display_name text)`);
    await client.query(`CREATE TABLE ${schema}.space_agent_registration_access
      (space_id text,owner_user_id text,machine_id text,harness text,grant_state text,policy_state text,
       grant_limits jsonb,policy_limits jsonb)`);
    await client.query(`CREATE TABLE ${schema}.messages
      (space_id text,channel_id text,message_id text,author_kind text,author_id text,body_hash text,
       invocation_input_version bigint,entity_version bigint,agent_invocation_targets_json jsonb,
       deleted_at timestamptz,recalled_at timestamptz)`);
    await client.query(`INSERT INTO ${schema}.agent_registration_authority VALUES ('space','composite')`);
    await client.query(`INSERT INTO ${schema}.channels VALUES ('channel','space','open','{}',1,NULL)`);
    await client.query(`INSERT INTO ${schema}.space_members VALUES
      ('space','human','member'),('space','owner','member'),('space','second-owner','member')`);
    for (const owner of ["owner", "second-owner"]) {
      await client.query(`INSERT INTO ${schema}.space_agent_registrations VALUES ('space',$1,'machine','codex','codex')`, [owner]);
      await client.query(`INSERT INTO ${schema}.space_agent_registration_access VALUES
        ('space',$1,'machine','codex','active','enabled','{"maxConcurrent":2}','{"maxConcurrent":2}')`, [owner]);
    }
    const body = "😀 @codex:new:org/repo help @human", text = "@codex:new:org/repo";
    const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const bodyHash = await digestCanonicalCloneCborV1(body);
    const envelope = { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: bodyHash,
      selections: [{ start: body.indexOf(text), end: body.indexOf(text) + text.length, text,
        target: { kind: "registration", key } }] };
    const input = { spaceId: "space", channelId: "channel", principal: { kind: "user", id: "human" },
      body, bodyHash, revision: 1, selections: envelope };
    assert.deepEqual(await authorizeMessageInvocationSelections(tx, input), envelope);
    const masked = bodyWithoutInvocationSelections(body, envelope);
    assert.equal(masked.length, body.length);
    assert.equal(masked.indexOf("@human"), body.indexOf("@human"));
    assert.ok(!masked.includes("codex"));
    const auto = { ...envelope, selections: [{ ...envelope.selections[0], target: { kind: "capability", harness: "codex" } }] };
    assert.deepEqual(await authorizeMessageInvocationSelections(tx, { ...input, selections: auto }), auto,
      "two same-label locations do not make an abstract capability ambiguous");
    const reject = (patch, code) => assert.rejects(() => authorizeMessageInvocationSelections(tx, { ...input, ...patch }),
      error => error.code === code);
    await reject({ body: body.replace("help", "changed") }, "invocation_selection_stale");
    await reject({ revision: 2 }, "invocation_selection_stale");
    await reject({ principal: { kind: "agent", id: "human" } }, "invocation_selection_forbidden");
    await reject({ selections: { ...envelope, selections: [{ ...envelope.selections[0],
      target: { kind: "registration", key: { ...key, spaceId: "other" } } }] } }, "invocation_selection_stale");
    await client.query(`UPDATE ${schema}.space_agent_registration_access SET grant_state='revoked' WHERE owner_user_id='owner'`);
    await reject({}, "invocation_target_unavailable");
    assert.deepEqual(await authorizeMessageInvocationSelections(tx, { ...input, selections: auto }), auto);
    await client.query(`UPDATE ${schema}.space_agent_registration_access SET grant_state='active'`);
    await client.query(`INSERT INTO ${schema}.messages VALUES ('space','channel','message','user','human',$1,1,2,$2,NULL,NULL)`,
      [bodyHash, JSON.stringify({ selections: envelope })]);
    const source = { spaceId: "space", channelId: "channel", messageId: "message", actorUserId: "human", body };
    assert.deepEqual(await readMessageInvocationSelections(tx, source), envelope,
      "a reaction's entity revision does not invalidate the unchanged invocation input");
    await client.query(`UPDATE ${schema}.messages SET invocation_input_version=2`);
    await assert.rejects(() => readMessageInvocationSelections(tx, source), error => error.code === "invocation_selection_stale");
    await client.query(`UPDATE ${schema}.messages SET invocation_input_version=1,recalled_at=now()`);
    await assert.rejects(() => readMessageInvocationSelections(tx, source), error => error.code === "invocation_source_unavailable");
    await client.query(`UPDATE ${schema}.channels SET mode='closed'`);
    await reject({}, "channel_not_found");
    await client.query(`UPDATE ${schema}.agent_registration_authority SET mode='prepared'`);
    await reject({}, "registration_cutover_required");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

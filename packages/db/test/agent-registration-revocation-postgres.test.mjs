import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { PostgresRegistrationAccessRepository, changeSpaceState } from "../dist/agent-registration-access.js";
import { PostgresRegistrationRevocationRepository } from "../dist/agent-registration-revocation.js";


integration("revocation persists exact stop obligations and settles ledger only after confirmed completion", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url }); await client.connect();
  const schema = `registration_stop_${process.pid}`;
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  const query = (text, values) => client.query(rewrite(text), values);
  try {
    await client.query("BEGIN"); await client.query(`CREATE SCHEMA ${schema}`);
    await query(`CREATE TABLE data.runs (run_id text PRIMARY KEY,owner_user_id text,channel_id text,
      status text,version bigint,metadata_json jsonb,updated_at timestamptz)`);
    for (const file of ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
      "0062_expand_registration_execution_revision.sql", "0063_expand_registration_authority.sql",
      "0067_expand_registration_grant_execution_revision.sql", "0068_expand_registration_run_bindings.sql",
      "0069_expand_registration_stop_intents.sql", "0133_expand_optional_stop_hostname.sql"]) {
      await query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    await query("ALTER TABLE data.registration_stop_intents ADD COLUMN hostname text");
    await query(`CREATE TABLE data.space_members (space_id text,user_id text,role text);
      CREATE TABLE data.channels (channel_id text,space_id text,mode text,metadata_json jsonb,version bigint,archived_at timestamptz);
      CREATE TABLE data.channel_access (channel_id text,space_id text,subject_kind text,subject_id text);
      CREATE TABLE data.instances (instance_id text,run_id text,channel_id text);
      CREATE TABLE data.agent_launches (launch_id text,run_id text,channel_id text,instance_id text,state text,retryable boolean,lease_owner text,
        lease_until timestamptz,version bigint,updated_at timestamptz,finished_at timestamptz);
      CREATE TABLE data.space_control_heads (space_id text PRIMARY KEY,commit_sequence bigint,updated_at timestamptz);
      CREATE TABLE data.outbox (outbox_id text PRIMARY KEY,space_id text,topic text,aggregate_kind text,aggregate_id text,
        aggregate_sequence bigint,payload_json jsonb,status text,attempts integer,available_at timestamptz,
        lease_until timestamptz,created_at timestamptz,updated_at timestamptz)`);
    const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback({ query: async statement => {
      const { rows } = await query(statement.text, statement.values);
      assert.ok(rows.length <= statement.maxRows, statement.name); return rows;
    } }) };
    const stops = new PostgresRegistrationRevocationRepository(database);
    const limits = { workspaces: ["repo"], models: ["model"], secrets: [], capabilities: [], maxConcurrent: 2 };
    let sequence = 0;
    const change = (spaceId, authority, expectedRevision, state, resources = limits) =>
      new PostgresRegistrationAccessRepository(database, { spaceId, shardId: "test", placementEpoch: 1 }).change({
        key: { spaceId, ownerUserId: "owner", machineId: "machine", harness: "codex" },
        expectedRevision, state, limits: resources, actorUserId: authority === "owner" ? "owner" : "admin",
        commandId: `change-${++sequence}` });
    await query(`INSERT INTO data.agent_registrations VALUES ('owner','machine','codex',1,now(),now())`);
    for (const space of ["space", "other"]) {
      await query(`INSERT INTO data.channels VALUES ($1,$1,'open','{}',1,NULL)`, [space]);
      await query(`INSERT INTO data.space_members VALUES ($1,'owner','member'),($1,'caller','member'),($1,'admin','admin')`, [space]);
      await query(`INSERT INTO data.agent_registration_authority VALUES ($1,'composite',repeat('a',64),1,now())`, [space]);
      await query(`INSERT INTO data.space_agent_registrations VALUES ($1,'owner','machine','codex','codex','{}',1,now(),now())`, [space]);
      await query(`INSERT INTO data.space_control_heads VALUES ($1,0,now())`, [space]);
      await change(space, "owner", 1, "active");
    }
    const addRun = async (id, space, status) => {
      await query(`INSERT INTO data.runs VALUES ($1,'owner',$2,$3,1,'{"hostId":"host","executionKey":"execution"}',now());`, [id, space, status]);
      await query(`INSERT INTO data.instances VALUES ($1,$2,$3)`, [`instance-${id}`, id, space]);
      await query(`INSERT INTO data.run_agent_registrations
        (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
         grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        SELECT $1,$2,'owner','machine','codex','caller',$1,repeat('a',64),grant_revision,grant_execution_revision,
          policy_revision,policy_execution_revision,$3::jsonb FROM data.space_agent_registration_access WHERE space_id=$2`,
      [id, space, JSON.stringify({ ...limits, maxConcurrent: 1 })]);
      await query(`INSERT INTO data.agent_launches VALUES ($1,$1,$3,$4,$2,TRUE,NULL,NULL,1,now(),NULL)`, [id, status === "starting" ? "queued" : "connected", space, `instance-${id}`]);
    };
    const states = async () => (await query(`SELECT run_id,status FROM data.runs ORDER BY run_id`)).rows;
    await addRun("accepted", "space", "running"); await addRun("queued", "space", "starting");
    await addRun("unrelated", "other", "running");
    await query(`UPDATE data.runs SET metadata_json=metadata_json-'hostId' WHERE run_id='queued'`);
    assert.equal(await stops.prepare("space"), 0);
    // A change that affects no execution yet is complete as it is recorded.
    assert.equal((await query(`SELECT count(*)::int AS count FROM data.registration_access_changes
      WHERE reconcile_state='pending'`)).rows[0].count, 0);
    assert.equal(await stops.completeChanges("space"), 0);
    // Expanding the grant keeps accepted work but fences a startup admitted under the old revision.
    await change("space", "owner", 2, "active", { ...limits, models: ["model", "model-b"] });
    assert.equal(await stops.prepare("space"), 1);
    assert.deepEqual(await states(), [{ run_id: "accepted", status: "running" }, { run_id: "queued", status: "stopping" },
      { run_id: "unrelated", status: "running" }]);
    assert.equal((await query(`SELECT state FROM data.agent_launches WHERE run_id='queued'`)).rows[0].state, "cancelled");
    assert.equal(await stops.completeChanges("space"), 0);
    const [first] = await stops.claim("space"); assert.equal(first.runId, "queued");
    assert.equal(first.hostId, "", "missing observation does not block an authorized revocation");
    assert.equal((await query(`SELECT hostname FROM data.registration_stop_intents WHERE run_id='queued'`)).rows[0].hostname, null);
    assert.deepEqual(await stops.claim("space"), [], "lease excludes a concurrent worker");
    await stops.settle({ intent: { ...first, leaseOwner: "stale-worker" }, completed: true });
    assert.equal((await query(`SELECT state FROM data.registration_stop_intents`)).rows[0].state, "pending");
    await stops.settle({ intent: first, replaceCommand: true, errorCode: "expired" });
    await query(`UPDATE data.registration_stop_intents SET next_attempt_at=now()`);
    const [retry] = await stops.claim("space");
    assert.equal(retry.runId, first.runId); assert.equal(retry.generation, 2); assert.notEqual(retry.controlId, first.controlId);
    await stops.settle({ intent: first, completed: true });
    assert.equal((await query(`SELECT state FROM data.registration_stop_intents`)).rows[0].state, "pending");
    await query(`UPDATE data.runs SET status='stopped' WHERE run_id='queued'`);
    await stops.settle({ intent: retry, completed: true });
    assert.equal(await stops.completeChanges("space"), 1, "an expansion settles without stopping accepted work");
    await change("space", "owner", 3, "revoked", { ...limits, models: ["model", "model-b"] });
    assert.equal(await stops.prepare("space"), 1); assert.equal(await stops.prepare("space"), 0);
    assert.equal((await query(`SELECT state FROM data.agent_launches WHERE run_id='accepted'`)).rows[0].state, "connected");
    assert.equal((await query(`SELECT status FROM data.runs WHERE run_id='unrelated'`)).rows[0].status, "running");
    assert.equal((await query(`SELECT count(*)::int AS count FROM data.outbox`)).rows[0].count, 2);
    assert.equal(await stops.completeChanges("space"), 0);
    const [revoked] = await stops.claim("space"); assert.equal(revoked.runId, "accepted");
    await stops.settle({ intent: revoked, errorCode: "offline" });
    assert.equal(await stops.completeChanges("space"), 0, "offline host leaves durable obligations pending");
    await query(`UPDATE data.registration_stop_intents SET created_at=now()-interval '3 days',next_attempt_at=now()
      WHERE run_id='accepted'`);
    const [aged] = await stops.claim("space"); assert.equal(aged.runId, "accepted");
    await stops.settle({ intent: aged, errorCode: "offline" });
    const agedDelay = (await query(`SELECT extract(epoch FROM next_attempt_at-clock_timestamp())::int AS seconds
      FROM data.registration_stop_intents WHERE run_id='accepted'`)).rows[0].seconds;
    assert.ok(agedDelay > 55 * 60 && agedDelay <= 60 * 60, `a days-old deferred stop retries hourly, not every 5 minutes (${agedDelay}s)`);
    await query(`UPDATE data.registration_stop_intents SET created_at=now(),next_attempt_at=clock_timestamp()+interval '10 seconds'
      WHERE run_id='accepted'`);
    await query(`DELETE FROM data.space_members WHERE space_id='other' AND user_id='caller'`);
    assert.equal(await stops.prepare("other"), 1, "current caller departure revokes physical execution even without an access-change row");
    assert.equal((await query(`SELECT status FROM data.runs WHERE run_id='unrelated'`)).rows[0].status, "stopping");
    await addRun("failed-start", "space", "failed");
    await query(`DELETE FROM data.instances WHERE run_id='failed-start'`);
    assert.equal(await stops.prepare("space"), 1, "failed startup still requires exact physical cleanup before freeing admission");
    const failedIntent = (await query(`SELECT instance_id,reason_code FROM data.registration_stop_intents WHERE run_id='failed-start'`)).rows[0];
    assert.deepEqual(failedIntent, { instance_id: "instance-failed-start", reason_code: "registration_run_terminal" });
    assert.equal((await query(`SELECT status FROM data.runs WHERE run_id='failed-start'`)).rows[0].status, "failed");
    await addRun("missing-target", "space", "running");
    await addRun("valid-target", "space", "running");
    await query(`UPDATE data.runs SET metadata_json='{}' WHERE run_id='missing-target'`);
    await assert.rejects(() => stops.prepare("space"), error => error.code === "registration_run_target_missing");
    assert.equal((await query(`SELECT status FROM data.runs WHERE run_id='valid-target'`)).rows[0].status, "stopping",
      "an invalid target does not roll back independently verified stop obligations");
    assert.equal((await query(`SELECT status FROM data.runs WHERE run_id='missing-target'`)).rows[0].status, "running");
    assert.equal(await stops.completeChanges("space"), 0);
    await assert.rejects(() => stops.settle({ intent: retry, completed: true, replaceCommand: true }),
      error => error.code === "invalid_stop_settlement");
    // The owner turned the agent off on its machine: its Runs stop in every Space.
    await query(`INSERT INTO data.space_members VALUES ('other','caller','member')`);
    await addRun("other-live", "other", "running");
    const key = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
    assert.deepEqual(await stops.activeRegistrations("other"), [key]);
    assert.equal(await stops.prepare("other"), 0);
    assert.equal(await stops.prepare("other", [{ ...key, machineId: "elsewhere" }]), 0, "another machine's switch stops nothing");
    assert.equal(await stops.prepare("other", [key]), 1);
    assert.deepEqual((await query(`SELECT reason_code FROM data.registration_stop_intents WHERE run_id='other-live'`)).rows,
      [{ reason_code: "registration_environment_disabled" }]);
    assert.equal((await query(`SELECT status FROM data.runs WHERE run_id='other-live'`)).rows[0].status, "stopping");
    assert.deepEqual(await stops.activeRegistrations("other"), []);
    // A Space admin disables it in that Space: its running work there stops.
    await addRun("other-second", "other", "running");
    await changeSpaceState(database, { spaceId: "other", shardId: "test", placementEpoch: 1 }, { key: { spaceId: "other",
      ownerUserId: "owner", machineId: "machine", harness: "codex" }, actorUserId: "admin", commandId: "disable-other",
    expectedRevision: 1, state: "disabled" });
    assert.equal(await stops.prepare("other"), 1);
    assert.deepEqual((await query(`SELECT reason_code FROM data.registration_stop_intents WHERE run_id='other-second'`)).rows,
      [{ reason_code: "registration_disabled" }]);
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

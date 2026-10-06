import { connectionString as url, integration, beginTestSchema, registrationChannelTables, savepointDatabase, applyTestMigrations } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresRegistrationAccessRepository, changeSpaceState, requireRegistrationAdmission } from "../dist/agent-registration-access.js";


integration("owner grants and Space policy mutations enforce roles, CAS, replay and durable reconciliation", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `registration_access_test_${process.pid}`;
  try {
    const sql = await beginTestSchema(client, schema);
    await client.query(`CREATE TABLE ${schema}.runs (run_id text PRIMARY KEY,owner_user_id text,channel_id text,
      status text,version bigint,metadata_json jsonb,updated_at timestamptz)`);
    await applyTestMigrations(client, ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql", "0062_expand_registration_execution_revision.sql", "0067_expand_registration_grant_execution_revision.sql", "0063_expand_registration_authority.sql",
      "0068_expand_registration_run_bindings.sql", "0069_expand_registration_stop_intents.sql"], sql);
    await client.query(`INSERT INTO ${schema}.agent_registration_authority (space_id,mode,manifest_digest,version)
      VALUES ('a','composite',repeat('a',64),1),('b','composite',repeat('b',64),1)`);
    await registrationChannelTables(client, schema);
    await client.query(`INSERT INTO ${schema}.channels VALUES ('channel-a','a','open','{}',1,NULL)`);
    await client.query(`INSERT INTO ${schema}.space_members VALUES
      ('a','owner','member'),('a','admin','admin'),('a','member','member'),('b','owner','member'),('b','admin','admin')`);
    await client.query(`INSERT INTO ${schema}.agent_registrations VALUES ('owner','machine','codex',1,now(),now())`);
    for (const space of ["a", "b"]) await client.query(`INSERT INTO ${schema}.space_agent_registrations
      VALUES ($1,'owner','machine','codex','codex','{}',1,now(),now())`, [space]);
    const database = savepointDatabase(client, sql);
    const repo = new PostgresRegistrationAccessRepository(database, { spaceId: "a", shardId: "test", placementEpoch: 1 });
    const key = { spaceId: "a", ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const limits = { workspaces: ["repo-a"], models: ["model-a"], secrets: [], capabilities: [], maxConcurrent: 2 };
    const grant = { key, actorUserId: "owner", state: "active", expectedRevision: 1,
      commandId: "grant-a", limits };
    const rejects = (input, code) => assert.rejects(() => repo.change(input), error => error.code === code);
    await rejects({ ...grant, actorUserId: "admin" }, "registration_owner_required");
    assert.deepEqual(await repo.change(grant), { revision: 2, reused: false });
    assert.deepEqual(await repo.change(grant), { revision: 2, reused: true });
    await rejects({ ...grant, state: "revoked" }, "idempotency_mismatch");
    await rejects({ ...grant, commandId: "stale-grant" }, "authorization_revision_conflict");
    // A Space admin may only remove (revoke); granting is the owner's.
    await rejects({ ...grant, actorUserId: "member", commandId: "member-grant", expectedRevision: 2 }, "registration_not_found");
    const admit = patch => database.transaction({}, tx => requireRegistrationAdmission(tx, {
      key, actorUserId: "member", channelId: "channel-a", requested: { ...limits, maxConcurrent: 1 }, ...patch,
    }));
    const admission = await admit({});
    assert.equal(admission.allowed, true);
    await assert.rejects(() => admit({ actorUserId: "outsider" }), error => error.code === "channel_not_found");
    await assert.rejects(() => admit({ key: { ...key, spaceId: "b" } }), error => error.code === "channel_not_found");
    await assert.rejects(() => admit({ fence: { ...admission.fence, grantRevision: 1 } }),
      error => error.code === "registration_stale_authorization");
    await rejects({ ...grant, key: { ...key, spaceId: "b" } }, "registration_not_found");
    // A Space owner/admin disables it in this Space: admitted work is fenced too.
    const placement = { spaceId: "a", shardId: "test", placementEpoch: 1 };
    const space = patch => changeSpaceState(database, placement, { key, actorUserId: "admin", commandId: "disable-a",
      expectedRevision: 1, state: "disabled", ...patch });
    await assert.rejects(() => space({ actorUserId: "member", commandId: "by-member" }),
      error => error.code === "space_policy_authority_required");
    assert.deepEqual(await space(), { revision: 2, reused: false });
    assert.deepEqual(await space(), { revision: 2, reused: true });
    await assert.rejects(() => space({ state: "enabled" }), error => error.code === "idempotency_mismatch");
    await assert.rejects(() => space({ commandId: "stale" }), error => error.code === "authorization_revision_conflict");
    await assert.rejects(() => admit({}), error => error.code === "registration_disabled");
    await assert.rejects(() => admit({ fence: admission.fence, phase: "continuation" }), error => error.code === "registration_disabled");
    assert.deepEqual((await client.query(`SELECT policy_state,policy_execution_revision FROM ${schema}.space_agent_registration_access
      WHERE space_id='a'`)).rows, [{ policy_state: "paused", policy_execution_revision: "2" }]);
    // The Agent's owner holds the same switch.
    assert.deepEqual(await space({ actorUserId: "owner", commandId: "enable-a", expectedRevision: 2, state: "enabled" }),
      { revision: 3, reused: false });
    assert.equal((await admit({})).allowed, true);
    await assert.rejects(() => admit({ fence: admission.fence, phase: "continuation" }),
      error => error.code === "registration_stale_authorization", "enabling does not revive stopped work");
    assert.deepEqual(await repo.change({ ...grant, expectedRevision: 2, state: "revoked", commandId: "revoke-a" }),
      { revision: 3, reused: false });
    await assert.rejects(() => admit({ fence: admission.fence }), error => error.code === "registration_revoked");
    // Nothing runs under this registration, so each recorded change completes as it is recorded.
    assert.deepEqual((await client.query(`SELECT reconcile_state,count(*)::int n FROM ${schema}.registration_access_changes
      GROUP BY reconcile_state`)).rows, [{ reconcile_state: "completed", n: 4 }]);
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${schema}.space_agent_registration_access
      WHERE space_id='b'`)).rows[0].n, 0);
    await client.query(`DELETE FROM ${schema}.space_members WHERE space_id='a' AND user_id='owner'`);
    await rejects(grant, "registration_not_found");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

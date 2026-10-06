import { connectionString as url, integration, beginTestSchema, registrationChannelTables, applyTestMigrations } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresRegistrationAccessRepository, requireRegistrationAdmission } from "../dist/agent-registration-access.js";
import { requireRunRegistrationAccess } from "../dist/agent-registration-run.js";


integration("Run registration authority survives pause but never revocation, membership loss or a changed scope", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url }); await client.connect();
  const schema = `registration_run_${process.pid}`;
  try {
    const rewrite = await beginTestSchema(client, schema);
    await client.query(`CREATE TABLE ${schema}.runs (run_id text PRIMARY KEY,owner_user_id text,channel_id text,
      status text DEFAULT 'running',version bigint DEFAULT 1,created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),metadata_json jsonb DEFAULT '{}')`);
    await applyTestMigrations(client, ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
      "0062_expand_registration_execution_revision.sql", "0063_expand_registration_authority.sql",
      "0067_expand_registration_grant_execution_revision.sql", "0068_expand_registration_run_bindings.sql", "0069_expand_registration_stop_intents.sql"], rewrite);
    await registrationChannelTables(client, schema);
    await client.query(`INSERT INTO ${schema}.channels VALUES ('channel','space','open','{}',1,NULL),
      ('other-channel','other-space','open','{}',1,NULL)`);
    await client.query(`INSERT INTO ${schema}.space_members VALUES ('space','owner','member'),
      ('space','admin','admin'),('space','caller','member')`);
    await client.query(`INSERT INTO ${schema}.agent_registration_authority(space_id,mode,manifest_digest,version)
      VALUES ('space','composite',repeat('a',64),1),('other-space','composite',repeat('b',64),1)`);
    await client.query(`INSERT INTO ${schema}.agent_registrations VALUES ('owner','machine','codex',1,now(),now())`);
    await client.query(`INSERT INTO ${schema}.space_agent_registrations
      VALUES ('space','owner','machine','codex','codex','{}',1,now(),now())`);
    const tx = { query: async ({ text, values, maxRows }) => {
      const { rows } = await client.query(rewrite(text), values); assert.ok(rows.length <= maxRows); return rows;
    } };
    const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback(tx) };
    const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const limits = { workspaces: ["repo"], models: ["model"], capabilities: ["approved-capability"], maxConcurrent: 2 };
    const requested = { ...limits, maxConcurrent: 1 };
    const access = new PostgresRegistrationAccessRepository(database, { spaceId: "space", shardId: "test", placementEpoch: 1 });
    let sequence = 0;
    const change = (authority, expectedRevision, state, resources = limits) => access.change({
      key, expectedRevision, state, actorUserId: authority === "owner" ? "owner" : "admin",
      commandId: `change-${++sequence}`, limits: resources });
    await change("owner", 1, "active");
    const admitted = await requireRegistrationAdmission(tx, { key, actorUserId: "caller", channelId: "channel", requested });
    await client.query(`INSERT INTO ${schema}.runs (run_id,owner_user_id,channel_id)
      VALUES ('run','owner','channel'),('unbound','owner','channel')`);
    await client.query(`INSERT INTO ${schema}.run_agent_registrations
      (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
       grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ('run','space','owner','machine','codex','caller','allocation',repeat('a',64),$1,$2,$3,$4,$5)`,
    [admitted.fence.grantRevision, admitted.fence.grantExecutionRevision, admitted.fence.policyRevision,
      admitted.fence.policyExecutionRevision, JSON.stringify(requested)]);
    const check = (patch = {}) => requireRunRegistrationAccess(tx, { runId: "run", channelId: "channel", phase: "continuation",
      error: (code, status) => Object.assign(new Error(code), { code, status }), ...patch });
    const denies = (patch, code) => assert.rejects(() => check(patch), error => error.code === code);
    await check(); await check({ phase: "admission" });
    await denies({ runId: "unbound" }, "registration_run_admission_missing");
    await denies({ channelId: "other-channel" }, "registration_run_admission_missing");
    await check({ resources: [{ kind: "capabilities", reference: "approved-capability" }] });
    await denies({ resources: [{ kind: "capabilities", reference: "approved-capability" },
      { kind: "capabilities", reference: "another-capability" }] }, "registration_resource_not_admitted");
    // An expanded grant keeps accepted work; a startup admitted before it is stale.
    await change("owner", 2, "active", { ...limits, models: ["model", "model-b"] });
    await check(); await denies({ phase: "admission" }, "registration_stale_authorization");
    await client.query(`UPDATE ${schema}.space_members SET role='viewer' WHERE user_id='caller'`);
    await denies({}, "channel_not_found");
    await client.query(`UPDATE ${schema}.space_members SET role='member' WHERE user_id='caller'`);
    await change("owner", 3, "revoked"); await denies({}, "registration_revoked");
    await change("owner", 4, "active"); await denies({}, "registration_stale_authorization");
    await client.query(`UPDATE ${schema}.run_agent_registrations SET grant_revision=5,grant_execution_revision=5`);
    await check();
    await client.query(`DELETE FROM ${schema}.space_members WHERE user_id='owner'`);
    await denies({}, "registration_membership");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

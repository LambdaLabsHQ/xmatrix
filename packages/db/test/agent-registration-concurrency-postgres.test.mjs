import { connectionString as url, integration, applyTestMigrations, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresAgentRegistrationRepository, PostgresRegistrationAccessRepository } from "../dist/index.js";


integration("concurrent offers converge and conflicting Space edits cannot overwrite each other", async () => {
  assert.ok(url);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  const schema = `registration_concurrency_${process.pid}`;
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(rewrite(`CREATE TABLE data.runs (run_id text PRIMARY KEY,owner_user_id text,channel_id text,
      status text,version bigint,metadata_json jsonb,updated_at timestamptz);
      CREATE TABLE data.channels (channel_id text,space_id text,mode text,metadata_json jsonb,version bigint,archived_at timestamptz);
      CREATE TABLE data.channel_access (channel_id text,space_id text,subject_kind text,subject_id text);
      CREATE TABLE data.instances (instance_id text,run_id text,channel_id text);
      CREATE TABLE data.agent_launches (launch_id text,run_id text,channel_id text,instance_id text,state text,retryable boolean,lease_owner text,
        lease_until timestamptz,version bigint,updated_at timestamptz,finished_at timestamptz)`));
    await applyTestMigrations(setup, ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
      "0061_expand_registration_commands.sql", "0062_expand_registration_execution_revision.sql", "0067_expand_registration_grant_execution_revision.sql", "0063_expand_registration_authority.sql", "0064_expand_registration_enrollments.sql", "0068_expand_registration_run_bindings.sql", "0069_expand_registration_stop_intents.sql", "0101_expand_registration_role.sql", "0102_contract_registration_create_command.sql"], rewrite);
    await setup.query(`INSERT INTO ${schema}.agent_registration_authority (space_id,mode,manifest_digest,version)
      VALUES ('a','composite',repeat('a',64),1),('b','composite',repeat('b',64),1)`);
    await setup.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,role text)`);
    await setup.query(`CREATE TABLE ${schema}.space_member_creation_policies (space_id text,agent_creation_policy text)`);
    await setup.query(`CREATE TABLE ${schema}.machine_daemons (daemon_id text,owner_user_id text,machine_id text)`);
    await setup.query(`INSERT INTO ${schema}.space_members VALUES ('a','owner','owner'),('a','admin','admin')`);
    await setup.query(`INSERT INTO ${schema}.machine_daemons VALUES ('daemon','owner','machine')`);
    const database = postgresConnections(5000, { rewrite });
    const placement = { spaceId: "a", shardId: "test", placementEpoch: 1 };
    const repo = new PostgresAgentRegistrationRepository(database, placement);
    const key = { spaceId: "a", ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const offer = { key, actorUserId: "owner", commandId: "same-offer", displayName: "codex" };
    const offered = await Promise.all([repo.offer(offer), repo.offer(offer), repo.offer({ ...offer, commandId: "other-offer" })]);
    assert.equal(offered.filter(result => result.reused).length, 1);
    assert.ok(offered.every(result => result.version === 1));
    assert.equal((await setup.query(`SELECT count(*)::int n FROM ${schema}.agent_registrations`)).rows[0].n, 1);
    assert.equal((await setup.query(`SELECT count(*)::int n FROM ${schema}.space_agent_registrations`)).rows[0].n, 1);
    const access = new PostgresRegistrationAccessRepository(database, placement);
    const limits = { models: ["model-a"], workspaces: [], secrets: [], capabilities: [], maxConcurrent: 2 };
    await access.change({ key, actorUserId: "owner", commandId: "grant",
      state: "active", expectedRevision: 1, limits });
    const configure = { key, actorUserId: "admin", commandId: "configure-a", expectedVersion: 1,
      displayName: "first", configuration: { model: "model-a", workspaceReferences: [], secretReferences: [] } };
    const changed = await Promise.allSettled([repo.configure(configure), repo.configure({ ...configure,
      actorUserId: "owner", commandId: "configure-b", displayName: "second" })]);
    assert.equal(changed.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(changed.find(result => result.status === "rejected").reason.code, "registration_version_conflict");
    assert.equal((await repo.get({ key, actorUserId: "owner", requestId: "read" })).version, 2);
    await access.change({ key, actorUserId: "owner", commandId: "expand-owner",
      state: "active", expectedRevision: 2, limits: { ...limits, models: ["model-a", "model-b"] } });
    await access.change({ key, actorUserId: "owner", commandId: "reduce-owner-capacity",
      state: "active", expectedRevision: 3, limits: { ...limits, models: ["model-a", "model-b"], maxConcurrent: 1 } });
    const grant = (await setup.query(`SELECT grant_revision,grant_execution_revision FROM ${schema}.space_agent_registration_access`)).rows[0];
    assert.equal(grant.grant_revision, "4");
    assert.equal(grant.grant_execution_revision, "2");
  } finally { await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end(); }
});

import { connectionString as url, integration, beginTestSchema, savepointDatabase } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { PostgresAgentRegistrationRepository, PostgresRegistrationAccessRepository, PostgresAgentEnvironmentRepository, changeSpaceState } from "../dist/index.js";


integration("composite registration commands preserve identity, configuration and owner/Space authority", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `registration_control_test_${process.pid}`;
  try {
    const sql = await beginTestSchema(client, schema);
    await client.query(sql(`CREATE TABLE data.runs (run_id text PRIMARY KEY,owner_user_id text,channel_id text,
      status text,version bigint,metadata_json jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz);
      CREATE TABLE data.channels (channel_id text,space_id text,mode text,metadata_json jsonb,version bigint,archived_at timestamptz);
      CREATE TABLE data.channel_access (channel_id text,space_id text,subject_kind text,subject_id text);
      CREATE TABLE data.instances (instance_id text,run_id text,channel_id text,channel_instance_id bigint,status text,
        presentation_json jsonb);
      CREATE TABLE data.agent_launches (launch_id text,run_id text,channel_id text,instance_id text,state text,retryable boolean,lease_owner text,
        lease_until timestamptz,version bigint,updated_at timestamptz,finished_at timestamptz)`));
    for (const file of ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql", "0062_expand_registration_execution_revision.sql", "0067_expand_registration_grant_execution_revision.sql", "0063_expand_registration_authority.sql", "0064_expand_registration_enrollments.sql",
      "0061_expand_registration_commands.sql", "0065_expand_registration_environment.sql", "0068_expand_registration_run_bindings.sql",
      "0071_expand_registration_quota_observations.sql", "0119_expand_registration_quota_windows.sql", "0158_expand_registration_quota_account.sql", "0069_expand_registration_stop_intents.sql", "0101_expand_registration_role.sql", "0102_contract_registration_create_command.sql"]) await client.query(sql(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")));
    await client.query(`INSERT INTO ${schema}.agent_registration_authority (space_id,mode,manifest_digest,version)
      VALUES ('a','composite',repeat('a',64),1),('b','composite',repeat('b',64),1)`);
    await client.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,role text)`);
    await client.query(`CREATE TABLE ${schema}.space_member_creation_policies (space_id text,agent_creation_policy text)`);
    await client.query(`CREATE TABLE ${schema}.machine_daemons (daemon_id text,owner_user_id text,machine_id text)`);
    await client.query(`INSERT INTO ${schema}.space_members VALUES
      ('a','owner','member'),('a','admin','admin'),('a','member','member'),('b','owner','member'),('b','admin','admin')`);
    await client.query(`INSERT INTO ${schema}.machine_daemons VALUES ('daemon','owner','machine')`);
    await client.query(`ALTER TABLE ${schema}.space_members ADD COLUMN display_name text DEFAULT 'Owner label'`);
    await client.query(`ALTER TABLE ${schema}.machine_daemons ADD COLUMN hostname text DEFAULT 'Workstation'`);
    await client.query(`ALTER TABLE ${schema}.machine_daemons ADD COLUMN updated_at timestamptz DEFAULT now()`);
    await client.query(`ALTER TABLE ${schema}.machine_daemons ADD COLUMN status text DEFAULT 'online'`);
    await client.query(`ALTER TABLE ${schema}.machine_daemons ADD COLUMN connection_epoch bigint DEFAULT 3`);
    await client.query(`ALTER TABLE ${schema}.machine_daemons ADD COLUMN metadata_json jsonb DEFAULT '{}'`);
    await client.query(`CREATE TABLE ${schema}.machines (owner_user_id text,machine_id text,name text)`);
    await client.query(`CREATE TABLE ${schema}.workspaces (workspace_id text,owner_user_id text,machine_id text,canonical_cwd text)`);
    const placement = { spaceId: "a", shardId: "test", placementEpoch: 1 };
    const database = savepointDatabase(client, sql, context => { if (["registration.enroll.global", "registration.machine-labels"].includes(context.operation) ||
          context.operation.startsWith("registration.environment.")) assert.equal(context.placement, undefined);
      else assert.equal(context.placement?.shardId, "test"); });
    const repo = new PostgresAgentRegistrationRepository(database, placement);
    const access = new PostgresRegistrationAccessRepository(database, placement);
    const key = { spaceId: "a", ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const offer = { key, actorUserId: "owner", commandId: "offer-a", displayName: "codex" };
    const rejects = (operation, code) => assert.rejects(operation, error => error.code === code);
    await rejects(() => repo.offer({ ...offer, actorUserId: "admin" }), "registration_owner_required");
    await rejects(() => repo.offer({ ...offer, key: { ...key, machineId: "unowned" } }), "registration_machine_not_owned");
    await rejects(() => repo.offer({ ...offer, key: { ...key, spaceId: "b" } }), "registration_not_found");
    assert.deepEqual(await repo.offer(offer), { key, version: 1, reused: false });
    assert.deepEqual(await repo.offer(offer), { key, version: 1, reused: true });
    await rejects(() => repo.offer({ ...offer, displayName: "changed" }), "idempotency_mismatch");
    await repo.offer({ ...offer, commandId: "offer-again", displayName: "must-not-overwrite" });
    assert.equal((await repo.get({ key, actorUserId: "owner", requestId: "get" })).displayName, "codex");
    await rejects(() => repo.get({ key, actorUserId: "member", requestId: "unshared" }), "registration_not_found");
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${schema}.agent_registrations`)).rows[0].n, 1);
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${schema}.space_agent_registration_access`)).rows[0].n, 0);
    const other = new PostgresAgentRegistrationRepository(database, { ...placement, spaceId: "b" });
    await other.offer({ ...offer, key: { ...key, spaceId: "b" }, commandId: "offer-b" });
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${schema}.agent_registrations`)).rows[0].n, 1);
    const configuration = { model: "model-a", workspaceReferences: ["repo-a"] };
    const configure = { key, actorUserId: "admin", commandId: "config-a", expectedVersion: 1, displayName: "renamed", configuration };
    await rejects(() => repo.configure(configure), "registration_not_granted");
    await access.change({ key, actorUserId: "owner", commandId: "grant-a", expectedRevision: 1,
      state: "active", limits: { workspaces: ["repo-a"], models: ["model-a"], capabilities: [], maxConcurrent: 2 } });
    await rejects(() => repo.configure({ ...configure, actorUserId: "owner" }), "space_policy_authority_required");
    await rejects(() => repo.configure({ ...configure, configuration: { ...configuration, workspaceReferences: ["repo-b"] } }),
      "space_configuration_exceeds_owner_grant");
    assert.deepEqual(await repo.configure(configure), { key, version: 2, reused: false });
    assert.deepEqual(await repo.configure(configure), { key, version: 2, reused: true });
    assert.deepEqual(await repo.configure({ ...configure, configuration: { ...configuration, backend: "other" } }),
      { key, version: 2, reused: true }, "unknown configuration fields are discarded before replay comparison");
    await rejects(() => repo.configure({ ...configure, commandId: "stale" }), "registration_version_conflict");
    const get = { key, actorUserId: "admin", requestId: "get-config" };
    assert.deepEqual((await repo.get(get)).configuration, configuration);
    assert.equal((await repo.get({ ...get, actorUserId: "member" })).configuration, undefined);
    assert.deepEqual((await other.get({ ...get, key: { ...key, spaceId: "b" } })).configuration,
      { workspaceReferences: [] });
    assert.equal((await client.query(`SELECT grant_revision FROM ${schema}.space_agent_registration_access`)).rows[0].grant_revision, "2");
    const listing = { spaceId: "a", actorUserId: "owner", requestId: "list" };
    let catalog = await repo.list(listing);
    assert.equal(catalog.registrations.length, 1);
    // The daemon's hostname is an observation and never names the Machine.
    assert.equal(catalog.registrations[0].machineName, "Registered machine");
    await client.query(`INSERT INTO ${schema}.machines VALUES ('owner','machine','Studio')`);
    catalog = await repo.list(listing);
    assert.equal(catalog.registrations[0].machineName, "Studio");
    assert.equal(catalog.registrations[0].ownerName, "Owner label");
    assert.equal(catalog.registrations[0].state, "enabled");
    assert.deepEqual(catalog.registrations[0].models, []);
    await new PostgresAgentEnvironmentRepository(database).change({
      key: { ownerUserId: "owner", machineId: "machine", harness: "codex" }, actorUserId: "owner", commandId: "physical",
      expectedVersion: 0, expectedMachineVersion: 0, machineMaxConcurrent: 2, environment: {
        schemaVersion: 1, enabled: true, models: ["model-a"], availability: "interactive", maxConcurrent: 2,
        description: "private physical description", capabilities: [],
      },
    });
    await repo.offer({ ...offer, key: { ...key, harness: "claude" }, commandId: "offer-claude" });
    catalog = await repo.list({ ...listing, limit: 1 });
    assert.equal(catalog.registrations[0].key.harness, "claude");
    const second = await repo.list({ ...listing, limit: 1, cursor: catalog.nextCursor });
    assert.equal(second.registrations[0].key.harness, "codex");
    assert.deepEqual(second.registrations[0].models, ["model-a"]);
    assert.equal(second.nextCursor, null);
    await client.query(`INSERT INTO ${schema}.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,updated_at)
      VALUES ('observed-run','owner','observed-channel','running',1,'{}',now())`);
    await client.query(`INSERT INTO ${schema}.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,
      actor_user_id,allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,
      policy_execution_revision,requested_json) VALUES ('observed-run','a','owner','machine','codex','owner',
      'observed-allocation',repeat('a',64),1,1,1,1,'{}')`);
    const parameters = [{ id: "future-speed", label: "Speed", options: ["turbo", "steady"] }];
    const modelObservation = { model: "model-a", parameters: [{ id: "model", label: "Model", options: ["model-a", "private-model"] }, ...parameters], parametersObservedAt: new Date(Date.now()-1000).toISOString(), modelsObservedAt: new Date().toISOString(), models: [
      { model: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep reasoning" }] },
      { model: "private-model", supportedReasoningEfforts: [{ reasoningEffort: "secret-effort" }] },
    ] };
    await client.query(`INSERT INTO ${schema}.instances (run_id,instance_id,presentation_json) VALUES ('observed-run','observed-instance',$1)`, [modelObservation]);
    const observedPage = await repo.list({ ...listing, actorUserId: "member" });
    assert.deepEqual(observedPage.registrations[0].modelCatalog,
      [{ model: "model-a", description: "", efforts: [{ value: "high", description: "Deep reasoning" }] }]);
    await client.query(`UPDATE ${schema}.instances SET presentation_json=$1`,
      [{ ...modelObservation, modelsObservedAt: new Date(Date.now()-2*86400000).toISOString() }]);
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "codex").modelCatalog, undefined);
    const independent = (await repo.list(listing)).registrations.find(row => row.key.harness === "codex");
    assert.deepEqual(independent.parameters, parameters, "parameter freshness is independent of model-catalog freshness");
    assert.equal(independent.parameterModel, "model-a");
    await client.query(`INSERT INTO ${schema}.instances (run_id,instance_id,presentation_json) VALUES ('observed-run','withdrawal-instance',$1)`,
      [{ parameters: [], parametersObservedAt: new Date().toISOString() }]);
    assert.deepEqual((await repo.list(listing)).registrations.find(row => row.key.harness === "codex").parameters, [],
      "a newer empty snapshot without models withdraws the old instance's choices");
    await client.query(`UPDATE ${schema}.instances SET presentation_json=jsonb_set(presentation_json,'{parametersObservedAt}',$1)`,
      [JSON.stringify(new Date(Date.now()-2*86400000).toISOString())]);
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "codex").parameters, undefined);

    const publicPage = await repo.list({ ...listing, actorUserId: "member" });
    assert.equal(publicPage.registrations.length, 1, "unshared locations stay private to their owner/admin");
    assert.equal(JSON.stringify(publicPage).includes("repo-a"), false);
    assert.equal(JSON.stringify(publicPage).includes("repo-a"), false);
    assert.equal(JSON.stringify(publicPage).includes("private physical"), false);
    await rejects(() => repo.list({ ...listing, cursor: "[1,2,3]" }), "invalid_registration_cursor");
    // Where a registration stands now: its machine's daemon, the Instances
    // running for this Space in Channels the reader may read, and the router's
    // current quota observation, which only its owner and Space admins receive.
    const codexLive = async actorUserId => (await repo.list({ ...listing, actorUserId }))
      .registrations.find(row => row.key.harness === "codex").live;
    await client.query(`INSERT INTO ${schema}.channels (channel_id,space_id,mode,metadata_json,version) VALUES
      ('open-channel','a','open','{}',1),('closed-channel','a','closed','{}',1),('other-space','b','open','{}',1)`);
    await client.query(`INSERT INTO ${schema}.channel_access (channel_id,space_id,subject_kind,subject_id)
      VALUES ('closed-channel','a','user','owner')`);
    await client.query(`INSERT INTO ${schema}.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ('open-run','owner','open-channel','running',1,'{"machineId":"machine"}','2026-09-28T10:00:00Z',now()),
      ('closed-run','owner','closed-channel','starting',1,'{"machineId":"machine"}','2026-09-28T11:00:00Z',now()),
      ('done-run','owner','open-channel','exited',1,'{"machineId":"machine"}','2026-09-28T09:00:00Z',now()),
      ('elsewhere-run','owner','other-space','running',1,'{"machineId":"machine"}','2026-09-28T08:00:00Z',now())`);
    for (const [run, space] of [["open-run", "a"], ["closed-run", "a"], ["done-run", "a"], ["elsewhere-run", "b"]]) {
      await client.query(`INSERT INTO ${schema}.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,
        actor_user_id,allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,
        policy_execution_revision,requested_json) VALUES ($1,$2,'owner','machine','codex','owner',$3,repeat('a',64),1,1,1,1,'{}')`,
      [run, space, `${run}-allocation`]);
    }
    await client.query(`INSERT INTO ${schema}.instances (instance_id,run_id,channel_id,channel_instance_id,status) VALUES
      ('open-instance','open-run','open-channel',2,'online'),('closed-instance','closed-run','closed-channel',1,'offline'),
      ('done-instance','done-run','open-channel',1,'offline'),('elsewhere-instance','elsewhere-run','other-space',1,'online')`);
    const ownerLive = await codexLive("owner");
    assert.equal(ownerLive.machine.online, true);
    assert.ok(Date.parse(ownerLive.machine.lastSeenAt));
    assert.deepEqual(ownerLive.running, [
      { instanceId: "open-instance", channelId: "open-channel", channelInstanceId: "2", since: "2026-09-28T10:00:00.000Z" },
      { instanceId: "closed-instance", channelId: "closed-channel", channelInstanceId: "1", since: "2026-09-28T11:00:00.000Z" },
    ], "a finished Run and another Space's work are not this Space's running Instances");
    assert.deepEqual((await codexLive("admin")).running.map(row => row.instanceId), ["open-instance", "closed-instance"]);
    assert.deepEqual((await codexLive("member")).running.map(row => row.instanceId), ["open-instance"],
      "a closed Channel the reader may not read is not named");
    assert.equal(ownerLive.quota, undefined, "no observation, no quota");
    await client.query(`INSERT INTO ${schema}.registration_quota_observations VALUES
      ('owner','registration:machine:codex',14,now()-interval '1 minute',now()+interval '1 hour','provider')`);
    assert.equal((await codexLive("owner")).quota.remainingPercent, 14);
    assert.equal((await codexLive("admin")).quota.remainingPercent, 14);
    assert.equal((await codexLive("member")).quota, undefined, "another member's provider account stays theirs");
    assert.equal((await codexLive("owner")).quota.windows, undefined, "a reading from before windows has none");
    const weekly = new Date(Date.now() + 86_400_000).toISOString();
    await client.query(`UPDATE ${schema}.registration_quota_observations SET windows_json=$1::jsonb`,
      [JSON.stringify([{ label: "5h", usedPercent: 30, resetAt: new Date(Date.now() - 1000).toISOString() },
        { label: "1w", usedPercent: 86, resetAt: weekly }, { usedPercent: 12 }])]);
    assert.deepEqual((await codexLive("owner")).quota.windows, [{ label: "1w", usedPercent: 86, resetAt: weekly },
      { usedPercent: 12 }], "a window that has reset since the reading is not shown");
    assert.equal((await codexLive("member")).quota, undefined);
    await client.query(`UPDATE ${schema}.registration_quota_observations
      SET observed_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'`);
    assert.equal((await codexLive("owner")).quota, undefined, "an expired reading is not the current quota");
    // The live connection's own load sample rides along; another connection's sample is not current load.
    const sample = (epoch) => JSON.stringify({ machineResources: { connectionEpoch: epoch, observedAt: "2026-09-01T00:00:00.000Z",
      cpuUsagePercent: 42, cpuLogicalCount: 8 } });
    await client.query(`UPDATE ${schema}.machine_daemons SET metadata_json=$1::jsonb`, [sample(3)]);
    assert.deepEqual((await codexLive("member")).machine.resources,
      { observedAt: "2026-09-01T00:00:00.000Z", cpuUsagePercent: 42, cpuLogicalCount: 8 });
    await client.query(`UPDATE ${schema}.machine_daemons SET metadata_json=$1::jsonb`, [sample(2)]);
    assert.equal((await codexLive("owner")).machine.resources, undefined);
    // The daemon's reported OS rides along, the desktop bridge's Node name read as the same OS.
    await client.query(`UPDATE ${schema}.machine_daemons SET metadata_json=jsonb_set($1::jsonb,'{platform}','"darwin"')`, [sample(3)]);
    assert.equal((await codexLive("member")).machine.platform, "macos");
    await client.query(`UPDATE ${schema}.machine_daemons SET metadata_json=jsonb_set($1::jsonb,'{platform}','"plan9"')`, [sample(3)]);
    assert.equal((await codexLive("member")).machine.platform, undefined, "an unknown OS is not passed on");
    await client.query(`UPDATE ${schema}.machine_daemons SET metadata_json=$1::jsonb`, [sample(3)]);
    await client.query(`UPDATE ${schema}.machine_daemons SET status='offline',updated_at='2026-09-01T00:00:00Z'`);
    assert.deepEqual((await codexLive("owner")).machine, { online: false, lastSeenAt: "2026-09-01T00:00:00.000Z" });
    await client.query(`UPDATE ${schema}.machine_daemons SET status='online',updated_at=now()`);
    // The Agent Role is retired. A registration assigned one before the
    // retirement keeps its stored snapshot untouched (the column's contract
    // migration is separate), but the snapshot is no longer read or written,
    // and a configuration carrying the retired assignment saves without it.
    const role = { roleId: "role-reviewer", roleVersion: "1.0.0", roleDigest: `sha256:${"c".repeat(64)}` };
    const snapshot = { ...role, name: "Reviewer", avatarUrl: "/roles/reviewer.png", initialPrompt: "Review carefully.",
      reminder: "Stay on the diff.", skills: [], appRequirements: [] };
    await client.query(`UPDATE ${schema}.space_agent_registrations SET role_json=$1::jsonb,
      configuration_json=configuration_json||jsonb_build_object('role',$2::jsonb)
      WHERE space_id='a' AND harness='codex'`, [JSON.stringify(snapshot), JSON.stringify(role)]);
    assert.equal((await repo.get(get)).role, undefined);
    assert.equal(Object.hasOwn((await repo.get(get)).configuration, "role"), false);
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "codex").role, undefined);
    assert.deepEqual(await repo.configure({ ...configure, commandId: "config-retired-role", expectedVersion: 2,
      configuration: { ...configuration, role } }), { key, version: 3, reused: false });
    const stored = (await client.query(`SELECT role_json,configuration_json FROM ${schema}.space_agent_registrations
      WHERE space_id='a' AND harness='codex'`)).rows[0];
    assert.deepEqual(stored.role_json, snapshot, "the retired snapshot is preserved, not deleted");
    assert.equal(Object.hasOwn(stored.configuration_json, "role"), false);
    assert.deepEqual(await repo.configure({ ...configure, commandId: "config-after-role", expectedVersion: 3 }),
      { key, version: 4, reused: false });
    // An owner adds an Agent on their own machine in one command: the harness is
    // declared, offered, granted the owner's Workspaces on that machine and enabled.
    await client.query(`INSERT INTO ${schema}.workspaces VALUES ('ws-1','owner','machine','/repo/one'),
      ('ws-2','owner','machine','/repo/two'),('ws-foreign','someone','machine','/repo/foreign')`);
    const createKey = { ...key, harness: "gemini" };
    const creation = { key: createKey, actorUserId: "owner", commandId: "create-gemini", displayName: "gemini",
      defaultWorkspace: "/repo/two", environment: { schemaVersion: 1, enabled: true, models: ["model-g"], description: "",
        availability: "interactive", capabilities: [], launch: { runtime: "gemini" } } };
    await rejects(() => repo.create({ ...creation, actorUserId: "admin" }), "registration_owner_required");
    await rejects(() => repo.create({ ...creation, environment: { ...creation.environment, launch: undefined } }),
      "invalid_registration_environment");
    await client.query(`INSERT INTO ${schema}.space_member_creation_policies VALUES ('a','admins')`);
    await rejects(() => repo.create(creation), "registration_creation_restricted");
    await client.query(`UPDATE ${schema}.space_member_creation_policies SET agent_creation_policy='members'`);
    assert.deepEqual(await repo.create(creation), { key: createKey, version: 1, reused: false });
    assert.deepEqual(await repo.create(creation), { key: createKey, version: 1, reused: true });
    // Adding it again with nothing new changes nothing.
    assert.deepEqual(await repo.create({ ...creation, commandId: "create-gemini-again" }),
      { key: createKey, version: 1, reused: false });
    const created = await repo.get({ key: createKey, actorUserId: "owner", requestId: "get-created" });
    assert.equal(created.displayName, "gemini");
    assert.equal(created.access.grant.state, "active");
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "gemini").state, "enabled");
    assert.deepEqual(created.configuration.workspaceReferences, ["ws-1", "ws-2"]);
    assert.equal(created.configuration.routing.defaultWorkspace, "ws-2");
    const createdAccess = (await client.query(`SELECT grant_state,policy_state,grant_limits FROM
      ${schema}.space_agent_registration_access WHERE space_id='a' AND harness='gemini'`)).rows[0];
    assert.equal(createdAccess.grant_state, "active");
    assert.equal(createdAccess.policy_state, "enabled");
    assert.deepEqual(createdAccess.grant_limits.workspaces, ["ws-1", "ws-2"]);
    assert.equal((await client.query(`SELECT declaration_json->'launch'->>'runtime' AS runtime FROM
      ${schema}.agent_registration_environments WHERE harness='gemini'`)).rows[0].runtime, "gemini");
    // A Workspace registered after the Agent was added reaches it when the owner
    // adds it again (#3162): configured, granted and allowed by the Space.
    await client.query(`INSERT INTO ${schema}.workspaces VALUES ('ws-3','owner','machine','/repo/three')`);
    await rejects(() => repo.create({ ...creation, actorUserId: "admin", commandId: "create-gemini-admin" }),
      "registration_owner_required");
    // Owner add-back must never undo a Space's independent disable or its fence.
    await changeSpaceState(database, placement, { key: createKey, actorUserId: "admin",
      commandId: "disable-gemini", expectedRevision: 1, state: "disabled" });
    const again = { ...creation, commandId: "create-gemini-ws3", defaultWorkspace: "/repo/three" };
    assert.deepEqual(await repo.create(again), { key: createKey, version: 2, reused: false });
    assert.deepEqual(await repo.create(again), { key: createKey, version: 2, reused: true });
    const widened = await repo.get({ key: createKey, actorUserId: "owner", requestId: "get-widened" });
    assert.deepEqual(widened.configuration.workspaceReferences, ["ws-1", "ws-2", "ws-3"]);
    assert.equal(widened.configuration.routing.defaultWorkspace, "ws-3");
    assert.deepEqual(widened.access.grant.limits.workspaces, ["ws-1", "ws-2", "ws-3"]);
    assert.deepEqual(widened.access.policy.limits.workspaces, ["ws-1", "ws-2", "ws-3"]);
    assert.equal(widened.access.grant.revision, 2);
    assert.equal(widened.access.grant.executionRevision, 1);
    assert.equal(widened.access.policy.state, "disabled");
    assert.equal(widened.access.policy.revision, 2);
    assert.equal(widened.access.policy.executionRevision, 2);
    // Removing it and adding it back restores the owner's grant.
    assert.deepEqual(await access.change({ key: createKey, actorUserId: "owner", commandId: "remove-gemini",
      expectedRevision: 2, state: "revoked", limits: widened.access.grant.limits }), { revision: 3, reused: false });
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "gemini").state, "revoked");
    assert.deepEqual(await repo.create({ ...creation, commandId: "create-gemini-restore" }),
      { key: createKey, version: 3, reused: false });
    const restored = await repo.get({ key: createKey, actorUserId: "owner", requestId: "get-restored" });
    assert.equal(restored.access.grant.state, "active");
    assert.equal(restored.access.grant.revision, 4);
    assert.equal(restored.access.grant.executionRevision, 4);
    // Naming a default Workspace again routes to it.
    assert.equal(restored.configuration.routing.defaultWorkspace, "ws-2");
    assert.equal(restored.access.policy.state, "disabled");
    assert.equal(restored.access.policy.revision, 2);
    assert.equal(restored.access.policy.executionRevision, 2);
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "gemini").state, "disabled");
    await changeSpaceState(database, placement, { key: createKey, actorUserId: "admin",
      commandId: "enable-gemini", expectedRevision: 2, state: "enabled" });
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "gemini").state, "enabled");
    // All grant writers retain replay evidence; add-back replays do not append it twice.
    const changes = (await client.query(`SELECT authority,revision,command_id,reconcile_state FROM
      ${schema}.registration_access_changes WHERE harness='gemini' ORDER BY authority,revision`)).rows;
    assert.deepEqual(changes.filter(row => row.authority === "owner").map(row => [
      Number(row.revision), row.command_id, row.reconcile_state,
    ]), [[2, "create-gemini-ws3", "completed"], [3, "remove-gemini", "completed"],
      [4, "create-gemini-restore", "completed"]]);
    // A grant failure rolls back the configuration update in that same command.
    await client.query(`UPDATE ${schema}.space_agent_registration_access
      SET grant_revision=$1 WHERE harness='gemini'`, [Number.MAX_SAFE_INTEGER]);
    await client.query(`INSERT INTO ${schema}.workspaces VALUES ('ws-4','owner','machine','/repo/four')`);
    await rejects(() => repo.create({ ...creation, commandId: "overflow-gemini", defaultWorkspace: "/repo/four" }),
      "authorization_revision_overflow");
    const unchanged = await repo.get({ key: createKey, actorUserId: "owner", requestId: "after-overflow" });
    assert.equal(unchanged.version, restored.version);
    assert.deepEqual(unchanged.configuration, restored.configuration);
    assert.deepEqual(unchanged.access.grant.limits, restored.access.grant.limits);
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${schema}.registration_access_changes
      WHERE command_id='overflow-gemini'`)).rows[0].n, 0);
    // A Space admin removes any member's registration from the Space but never
    // grants it back or rewrites the owner's limits; a plain member does neither.
    const grantLimits = { workspaces: ["repo-a"], models: ["model-a"], capabilities: [], maxConcurrent: 2 };
    const removal = { key, actorUserId: "admin", commandId: "admin-remove", expectedRevision: 2,
      state: "revoked", limits: grantLimits };
    assert.equal((await repo.get({ key, actorUserId: "admin", requestId: "admin-caps" })).canRemoveFromSpace, true);
    assert.equal((await repo.get({ key, actorUserId: "member", requestId: "member-caps" })).canRemoveFromSpace, false);
    assert.equal((await repo.list({ ...listing, actorUserId: "admin" })).registrations.every(row => row.canRemoveFromSpace), true);
    await rejects(() => access.change({ ...removal, actorUserId: "member" }), "registration_not_found");
    await rejects(() => access.change({ ...removal, state: "active" }), "registration_owner_required");
    await rejects(() => access.change({ ...removal, limits: { ...grantLimits, models: ["model-a", "model-b"] } }),
      "registration_owner_required");
    assert.deepEqual(await access.change(removal), { revision: 3, reused: false });
    assert.equal((await repo.list(listing)).registrations.find(row => row.key.harness === "codex").state, "revoked");
    await rejects(() => access.change({ ...removal, commandId: "admin-restore", expectedRevision: 3, state: "active" }),
      "registration_owner_required");
    assert.deepEqual(await access.change({ ...removal, actorUserId: "owner", commandId: "owner-restore", expectedRevision: 3,
      state: "active" }), { revision: 4, reused: false });
    await client.query(`UPDATE ${schema}.space_members SET role='member' WHERE user_id='admin' AND space_id='a'`);
    await rejects(() => repo.configure(configure), "space_policy_authority_required");
    await client.query(`DELETE FROM ${schema}.space_members WHERE space_id='a' AND user_id='owner'`);
    await rejects(() => repo.offer(offer), "registration_not_found");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

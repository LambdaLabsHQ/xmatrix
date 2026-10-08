import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { PostgresRegistrationLaunchRepository, reconcileRegistrationPreparationCancellations } from "../dist/agent-registration-launch.js";
import { PostgresRegistrationAccessRepository } from "../dist/agent-registration-access.js";
import { PostgresRegistrationExecutionRepository } from "../dist/agent-registration-execution.js";
import { PostgresAgentEnvironmentRepository } from "../dist/agent-registration-environment.js";
import { cleanLifecycleData, launchRequestDigest } from "../scripts/agent-lifecycle-cleanup.mjs";
import { RegistrationAccessError } from "../dist/agent-registration-errors.js";
import { DatabaseCommitUnknownError } from "../dist/errors.js";
import { PostgresRegistrationRebornRepository } from "../dist/registration-reborn.js";


integration("launch survives a hostname change with stale Workspace metadata and recovers unknown commits exactly", async () => {
  assert.ok(url);
  const schema = `registration_launch_${process.pid}`;
  const setup = new Client({ connectionString: url }); await setup.connect();
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  const sql = (text, values) => setup.query(rewrite(text), values);
  let afterCommit;
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["0009_expand_remaining_control_facts.sql", "0014_expand_current_control_fact_shapes.sql", "0036_expand_agent_launches.sql",
      "0037_expand_agent_launch_timeline.sql", "0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
      "0062_expand_registration_execution_revision.sql", "0063_expand_registration_authority.sql",
      "0065_expand_registration_environment.sql", "0066_expand_registration_allocations.sql",
      "0067_expand_registration_grant_execution_revision.sql", "0068_expand_registration_run_bindings.sql",
      "0069_expand_registration_stop_intents.sql", "0070_expand_registration_launch_intents.sql", "0071_expand_registration_quota_observations.sql",
      "0119_expand_registration_quota_windows.sql", "0158_expand_registration_quota_account.sql",
      "0074_expand_registration_launch_request.sql", "0076_expand_nullable_profile_references.sql",
      "0078_expand_registration_launch_input.sql", "0079_expand_registration_optional_model.sql",
      "0083_expand_natural_key_reservations.sql",
      "0058_expand_reborn_intents.sql", "0073_expand_reborn_failure_notice.sql",
      "0001_expand_space_placement.sql", "0024_expand_global_space_routing.sql", "0057_expand_agent_display_names.sql",
      "0117_expand_instance_rest_state.sql", "0160_expand_instance_wake.sql"]) {
      await sql(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    await sql(`ALTER TABLE data.instances ADD COLUMN IF NOT EXISTS presentation_json jsonb NOT NULL DEFAULT '{}'::jsonb;
      CREATE TABLE data.space_members (space_id text,user_id text,role text);
      CREATE TABLE data.spaces (space_id text PRIMARY KEY,metadata_json jsonb);
      CREATE TABLE data.pages (space_id text,page_id text);
      CREATE TABLE data.channels (channel_id text,space_id text,mode text,metadata_json jsonb,version bigint,archived_at timestamptz);
      CREATE TABLE data.channel_access (channel_id text,space_id text,subject_kind text,subject_id text);
      CREATE TABLE data.messages (space_id text,channel_id text,message_id text,author_kind text,author_id text,
        body_hash text,entity_version bigint,invocation_input_version bigint,timeline_sequence bigint,
        agent_invocation_targets_json jsonb,edited_at timestamptz,deleted_at timestamptz,recalled_at timestamptz);
      CREATE TABLE data.delivery_cursors (space_id text,subject_id text,channel_id text,acknowledged_sequence bigint,
        version bigint,updated_at timestamptz,PRIMARY KEY (space_id,subject_id,channel_id));
      CREATE TABLE data.message_attention_revisions (space_id text,subject_id text,channel_id text,revision bigint,
        updated_at timestamptz,PRIMARY KEY (space_id,subject_id,channel_id));
      CREATE TABLE data.first_message_launch_choices (space_id text,channel_id text,message_id text,author_user_id text,choice text);
      CREATE TABLE data.machine_daemons (daemon_id text,owner_user_id text,machine_id text,hostname text,status text,
        capabilities_json jsonb,connection_epoch bigint);
      CREATE TABLE data.machine_run_routes (run_id text,owner_user_id text,machine_id text,terminal_at timestamptz);
      CREATE TABLE data.space_control_heads (space_id text PRIMARY KEY,commit_sequence bigint,updated_at timestamptz);
      CREATE TABLE data.outbox (outbox_id text PRIMARY KEY,space_id text,topic text,aggregate_kind text,aggregate_id text,
        aggregate_sequence bigint,payload_json jsonb,status text,attempts integer,available_at timestamptz,
        lease_until timestamptz,created_at timestamptz,updated_at timestamptz)`);
    const database = postgresConnections(5000, { rewrite, afterCommit: context => afterCommit?.(context) });
    const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const placement = { spaceId: "space", shardId: "test", placementEpoch: 1 };
    const limits = { workspaces: ["workspace"], models: ["model"], secrets: [], capabilities: [], maxConcurrent: 4 };
    await sql(`INSERT INTO data.space_members VALUES ('space','owner','owner'),('space','caller','member');
      INSERT INTO data.spaces VALUES ('space','{"governancePageId":"p-rules"}');
      INSERT INTO data.pages VALUES ('space','p-rules');
      INSERT INTO data.channels VALUES ('channel','space','open','{}',1,NULL);
      INSERT INTO data.agent_registration_authority VALUES ('space','composite',repeat('a',64),1,now());
      INSERT INTO data.agent_registrations VALUES ('owner','machine','codex',1,now(),now());
      INSERT INTO data.space_agent_registrations VALUES ('space','owner','machine','codex','Codex',
        '{"workspaceReferences":["workspace"],"secretReferences":[],"model":"model","routing":{"schemaVersion":1,"enabled":true,"models":["model"],"description":"test","maxConcurrent":4}}',1,now(),now());
      INSERT INTO data.machine_daemons VALUES ('daemon','owner','machine','renamed-host','online','["registration_launch_v2","registration_launch_v3"]',1);
      INSERT INTO data.space_control_heads VALUES ('space',0,now());
      INSERT INTO data.workspaces (workspace_id,owner_user_id,machine_id,canonical_cwd,version,metadata_json,created_at,updated_at)
        VALUES ('workspace','owner','machine','/repo',1,'{"hostId":"host","displayName":"Repo"}',now(),now())`);
    await sql(`ALTER TABLE data.machine_daemons ADD COLUMN metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await sql(`ALTER TABLE data.agent_launches ALTER COLUMN host_id DROP NOT NULL;
      ALTER TABLE data.agent_launches ADD COLUMN hostname text;
      ALTER TABLE data.agent_reborn_intents ALTER COLUMN host_id DROP NOT NULL;
      ALTER TABLE data.agent_reborn_intents ADD COLUMN hostname text;
      ALTER TABLE data.registration_stop_intents ALTER COLUMN host_id DROP NOT NULL;
      ALTER TABLE data.registration_stop_intents ADD COLUMN hostname text`);
    await sql(`CREATE TABLE data.machines (owner_user_id text,machine_id text,name text,retired_at timestamptz,auto_assign boolean)`);
    const access = new PostgresRegistrationAccessRepository(database, placement);
    await access.change({ key, actorUserId: "owner", commandId: "grant", expectedRevision: 1, state: "active", limits });
    const { spaceId: _space, ...physical } = key;
    await new PostgresAgentEnvironmentRepository(database).change({ key: physical, actorUserId: "owner", commandId: "environment",
      expectedVersion: 0, expectedMachineVersion: 0, machineMaxConcurrent: 4,
      environment: { schemaVersion: 1, enabled: true, models: ["model"], modelAliases: { model: "provider/model" },
        description: "", availability: "unattended", maxConcurrent: 4, capabilities: [],
        launch: { runtime: "/opt/codex/bin/codex", runtimeArgs: ["--full-auto"], backend: "codex-app", sandboxMode: "workspace-write" } } });
    const body = "@codex task", bodyHash = await digestCanonicalCloneCborV1(body);
    const source = async id => sql(`INSERT INTO data.messages VALUES ('space','channel',$1,'user','caller',$2,1,1,1,$3,NULL,NULL,NULL)`,
      [id, bodyHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: bodyHash,
        selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "registration", key } }] } }]);
    await source("message");
    const launches = new PostgresRegistrationLaunchRepository(database, database, placement);
    const request = { key, commandId: "launch", actorUserId: "caller", channelId: "channel", sourceMessageId: "message",
      selectionIndex: 0, body, workspaceReference: "workspace", requirements: { model: "model", effort: "high", unattended: false, requiredCapabilities: [] } };
    afterCommit = context => {
      if (context.operation === "registration.launch.commit") { afterCommit = undefined; throw new DatabaseCommitUnknownError("connection_lost"); }
    };
    await assert.rejects(() => launches.prepare(request), error => error.code === "database_commit_unknown");
    const recoveredCommit = await launches.recoverFromMessage({ commandId: request.commandId, actorUserId: request.actorUserId,
      channelId: request.channelId, sourceMessageId: request.sourceMessageId, selectionIndex: 0, body });
    assert.equal(recoveredCommit.reused, true);
    const replay = await launches.prepare(request); assert.equal(replay.reused, true);
    assert.equal(recoveredCommit.launchId, replay.launchId);
    // A stored request written before removal must still recover the same Run
    // after its redundant field and canonical idempotency digest are migrated.
    const originalIntent = (await sql("SELECT * FROM data.registration_launch_intents WHERE command_id='launch'")).rows[0];
    assert.equal(await launchRequestDigest(originalIntent.launch_request_json, originalIntent.source_body_hash), originalIntent.request_digest);
    const cleanedRequest = cleanLifecycleData({ ...originalIntent.launch_request_json, oneshot: "on" });
    await sql("UPDATE data.registration_launch_intents SET launch_request_json=$1,request_digest=$2 WHERE command_id='launch'",
      [cleanedRequest, await launchRequestDigest(cleanedRequest, originalIntent.source_body_hash)]);
    assert.equal((await launches.prepare(request)).runId, replay.runId);

    for (const table of ["runs", "instances", "agent_launches", "run_agent_registrations", "registration_execution_allocations"]) {
      assert.equal((await sql(`SELECT count(*)::int AS count FROM data.${table}`)).rows[0].count, 1, table);
    }
    const run = (await sql(`SELECT * FROM data.runs`)).rows[0];
    // Staging reserved the natural key, so the lost commit and its replay share it.
    const committedInstance = (await sql(`SELECT instance_id,channel_instance_id FROM data.instances`)).rows[0];
    assert.equal(run.run_id, `channel:${committedInstance.channel_instance_id}#1`);
    assert.equal(committedInstance.instance_id, `channel:${committedInstance.channel_instance_id}`);
    assert.equal(run.owner_user_id, "owner");
    const launch = (await sql(`SELECT * FROM data.agent_launches`)).rows[0];
    assert.deepEqual(launch.spawn_payload_json.registration.key, key);
    assert.equal(launch.spawn_payload_json.spaceRulesPageId, "p-rules");
    const sessionKey = `resume:owner:channel:${replay.instanceId}`;
    assert.equal(run.metadata_json.resumeSessionKey, sessionKey);
    assert.equal(launch.spawn_payload_json.resumeSessionKey, sessionKey);
    assert.equal(launch.spawn_payload_json.exitAfterInitialMessage, undefined);
    assert.equal(launch.spawn_payload_json.registration.runtimeModel, "provider/model");
    assert.equal(launch.spawn_payload_json.context.requestedModel, "provider/model");
    assert.equal(launch.spawn_payload_json.context.requestedEffort, "high");
    assert.equal(launch.spawn_payload_json.workspace.canonicalCwd, "/repo");
    // The Hub maintains how the machine starts the harness.
    assert.equal(launch.spawn_payload_json.runtime, "/opt/codex/bin/codex");
    assert.deepEqual(launch.spawn_payload_json.runtimeArgs, ["--full-auto"]);
    assert.equal(launch.spawn_payload_json.agentBackend, "codex-app");
    // A stored sandbox mode is retired: older daemons are told "off".
    assert.equal(launch.spawn_payload_json.sandboxMode, "off");
    await assert.rejects(() => launches.prepare({ ...request,
      requirements: { ...request.requirements, effort: "low" } }),
    error => error.code === "idempotency_mismatch");
    assert.equal(launch.spawn_payload_json.context.initialMessageSource.bodyHash, bodyHash);
    const admission = { requestId: "admit", key, runId: replay.runId,
      allocationId: launch.spawn_payload_json.registration.allocationId,
      authorizationDigest: launch.spawn_payload_json.registration.authorizationDigest,
      daemonId: "daemon", connectionEpoch: 1, hostId: "host", expectedWorkspace: { reference: "workspace", canonicalCwd: "/repo" } };
    const capacity = new PostgresRegistrationExecutionRepository(database);
    await assert.rejects(() => capacity.admit({ ...admission, expectedWorkspace: { reference: "another-workspace", canonicalCwd: "/repo" } }),
      error => error.code === "allocation_workspace_changed");
    await assert.rejects(() => capacity.admit({ ...admission, expectedWorkspace: { reference: "workspace", canonicalCwd: "/other" } }),
      error => error.code === "allocation_workspace_changed");
    assert.equal((await capacity.admit(admission)).state, "admitted");
    await assert.rejects(() => launches.prepare({ ...request, body: "@codex changed" }), /Invocation source has changed/u);
    await source("edited-source");
    afterCommit = async context => {
      if (context.operation === "registration.execution.reserve") {
        afterCommit = undefined;
        await sql(`UPDATE data.messages SET invocation_input_version=2 WHERE message_id='edited-source'`);
      }
    };
    await assert.rejects(() => launches.prepare({ ...request, commandId: "edited", sourceMessageId: "edited-source" }));
    const aborted = (await sql(`SELECT * FROM data.registration_launch_intents WHERE command_id='edited'`)).rows[0];
    assert.equal(aborted.state, "aborted");
    assert.equal((await sql(`SELECT state FROM data.registration_execution_allocations WHERE run_id=$1`, [aborted.run_id])).rows[0].state, "released");
    await source("lost-reserve");
    afterCommit = context => {
      if (context.operation === "registration.execution.reserve") { afterCommit = undefined; throw new DatabaseCommitUnknownError("connection_lost"); }
    };
    await assert.rejects(() => launches.prepare({ ...request, commandId: "lost", sourceMessageId: "lost-reserve" }), error => error.code === "database_commit_unknown");
    const stagedRequest = (await sql(`SELECT launch_request_json FROM data.registration_launch_intents WHERE command_id='lost'`)).rows[0].launch_request_json;
    assert.equal(stagedRequest.requirements.effort, "high");
    assert.equal(stagedRequest.workspaceReference, "workspace");
    assert.equal(Object.hasOwn(stagedRequest, "body"), false);
    await access.change({ key, actorUserId: "owner", commandId: "revoke", expectedRevision: 2, state: "revoked", limits });
    // Lock order: the recheck takes the Channel before any intent, as staging
    // and commit do. While another transaction holds the Channel, the waiting
    // recheck must not hold the intent a commit would wait for next.
    await sql(`UPDATE data.registration_launch_intents SET next_check_at=clock_timestamp()-interval '1 second' WHERE command_id='lost'`);
    const channelHolder = new Client({ connectionString: url }); await channelHolder.connect();
    const intentProbe = new Client({ connectionString: url }); await intentProbe.connect();
    let intentLockedByWaitingRecheck = false;
    try {
      await channelHolder.query("BEGIN");
      await channelHolder.query(rewrite("SELECT 1 FROM data.channels WHERE channel_id='channel' FOR UPDATE"));
      const recheck = reconcileRegistrationPreparationCancellations(database, database, "channel");
      await new Promise(resolve => setTimeout(resolve, 300));
      await intentProbe.query("BEGIN");
      try {
        await intentProbe.query(rewrite("SELECT 1 FROM data.registration_launch_intents WHERE command_id='lost' FOR UPDATE NOWAIT"));
      } catch (error) {
        if (error.code !== "55P03") throw error;
        intentLockedByWaitingRecheck = true;
      }
      await intentProbe.query("ROLLBACK");
      await channelHolder.query("COMMIT");
      await recheck;
    } finally {
      await intentProbe.end(); await channelHolder.end();
    }
    assert.equal(intentLockedByWaitingRecheck, false, "a recheck waiting for the Channel holds no intent lock");
    const lost = (await sql(`SELECT * FROM data.registration_launch_intents WHERE command_id='lost'`)).rows[0];
    assert.equal(lost.state, "aborted"); assert.equal(lost.cancellation_completed, true);
    assert.equal((await sql(`SELECT state FROM data.registration_execution_allocations WHERE run_id=$1`, [lost.run_id])).rows[0].state, "released");
    assert.equal((await sql(`SELECT count(*)::int AS count FROM data.runs`)).rows[0].count, 1);
    await access.change({ key, actorUserId: "owner", commandId: "regrant", expectedRevision: 3, state: "active", limits });
    // A valid preparation whose request died and was never retried is
    // abandoned after the retry window: it must not hold capacity forever.
    await source("orphan-source");
    afterCommit = context => {
      if (context.operation === "registration.execution.reserve") { afterCommit = undefined; throw new DatabaseCommitUnknownError("connection_lost"); }
    };
    await assert.rejects(() => launches.prepare({ ...request, commandId: "orphan", sourceMessageId: "orphan-source" }),
      error => error.code === "database_commit_unknown");
    await sql(`UPDATE data.registration_launch_intents SET next_check_at=clock_timestamp()-interval '1 second' WHERE command_id='orphan'`);
    await reconcileRegistrationPreparationCancellations(database, database, "channel");
    assert.equal((await sql(`SELECT state FROM data.registration_launch_intents WHERE command_id='orphan'`)).rows[0].state, "preparing",
      "a valid preparation inside its retry window keeps waiting for the retry");
    await sql(`UPDATE data.registration_launch_intents SET next_check_at=clock_timestamp()-interval '1 second',
      created_at=clock_timestamp()-interval '11 minutes' WHERE command_id='orphan'`);
    await reconcileRegistrationPreparationCancellations(database, database, "channel");
    const orphan = (await sql(`SELECT * FROM data.registration_launch_intents WHERE command_id='orphan'`)).rows[0];
    assert.equal(orphan.state, "aborted"); assert.equal(orphan.cancellation_completed, true);
    assert.equal((await sql(`SELECT state FROM data.registration_execution_allocations WHERE run_id=$1`, [orphan.run_id])).rows[0].state, "released");
    await assert.rejects(() => launches.prepare({ ...request, commandId: "orphan", sourceMessageId: "orphan-source" }),
      error => error.code === "registration_launch_aborted");
    // An Agent Run's own summon (a Focus delegate, an Agent launching another)
    // stays valid when the staged-launch recheck runs before it commits.
    await sql(`INSERT INTO data.messages VALUES ('space','channel','agent-source','agent',$1,$2,1,1,1,$3,NULL,NULL,NULL)`,
      [committedInstance.instance_id, bodyHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: bodyHash,
        selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "registration", key } }] } }]);
    afterCommit = async context => {
      if (context.operation === "registration.execution.reserve") {
        afterCommit = undefined;
        await sql(`UPDATE data.registration_launch_intents SET next_check_at=clock_timestamp()-interval '1 second'
          WHERE command_id='agent-authored'`);
        await reconcileRegistrationPreparationCancellations(database, database, "channel");
      }
    };
    const agentAuthored = await launches.prepare({ ...request, commandId: "agent-authored", actorUserId: "owner",
      sourceMessageId: "agent-source" });
    assert.equal(afterCommit, undefined, "the recheck ran between reservation and commit");
    assert.equal(agentAuthored.reused, false);
    assert.equal((await sql(`SELECT state FROM data.registration_launch_intents WHERE command_id='agent-authored'`)).rows[0].state,
      "committed");
    const parameterBody = "@codex model:model effort:high machine:machine harness:codex pwd:/repo param.serviceTier:future-priority";
    await sql(`UPDATE data.machine_daemons SET capabilities_json=capabilities_json||'["machine_routing_parameters_v1"]'::jsonb`);
    const parameterHash = await digestCanonicalCloneCborV1(parameterBody);
    await sql(`INSERT INTO data.messages VALUES ('space','channel','explicit-parameters','user','caller',$1,1,1,1,$2,NULL,NULL,NULL)`,
      [parameterHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: parameterHash,
        selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "registration", key } }] } }]);
    const explicitRequest = { ...request, commandId: "explicit-parameters", sourceMessageId: "explicit-parameters",
      body: parameterBody, requirements: { ...request.requirements, parameters: { serviceTier: "future-priority" } } };
    for (const changed of [ { requirements: { ...request.requirements, model: "other" } },
      { requirements: { ...request.requirements, effort: "low" } }, { useRuntimeDefaultModel: true }]) {
      await assert.rejects(launches.prepare({ ...explicitRequest, ...changed }), error => error.code === "invalid_registration_launch");
    }
    const parameterLaunch = await launches.prepare(explicitRequest);
    const parameterPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [parameterLaunch.launchId])).rows[0].spawn_payload_json;
    assert.equal(parameterPayload.context.requestedModel, "provider/model");
    assert.equal(parameterPayload.context.requestedEffort, "high");
    assert.deepEqual(parameterPayload.context.requestedParameters, { serviceTier: "future-priority" });
    assert.equal(parameterPayload.exitAfterInitialMessage, undefined);
    assert.equal(parameterPayload.workspace.canonicalCwd, "/repo");
    assert.equal(parameterPayload.prompt, parameterBody);
    assert.equal((await launches.prepare(explicitRequest)).launchId, parameterLaunch.launchId);
    await sql(`INSERT INTO data.messages VALUES ('space','channel','cold-parameters','user','caller',$1,1,1,1,$2,NULL,NULL,NULL)`,
      [parameterHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: parameterHash,
        selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "registration", key } }] } }]);
    const coldLaunch = await launches.dispatchFromMessage({ commandId: "cold-parameters", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "cold-parameters", body: parameterBody }, async ({ candidates }) => {
        assert.equal(candidates[0].parameters, undefined);
        assert.equal(candidates[0].supportsRequestedParameters, true);
        return { key, model: "model", effort: "high", workspaceReference: "workspace",
          parameters: { serviceTier: "future-priority" } };
      });
    assert.equal(coldLaunch.prepared.length, 1);
    const coldPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [coldLaunch.prepared[0].launchId])).rows[0].spawn_payload_json;
    assert.deepEqual(coldPayload.context.requestedParameters, { serviceTier: "future-priority" });
    await sql(`UPDATE data.instances SET presentation_json=$1 WHERE instance_id=$2`, [{
      model: "provider/model", parametersObservedAt: new Date().toISOString(),
      parameters: [{ id: "serviceTier", label: "Service tier", options: ["future-priority"] }],
      modelsObservedAt: new Date().toISOString(), models: [{ model: "provider/model", description: "Observed model",
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Thorough" }] }],
    }, parameterLaunch.instanceId]);
    await sql(`UPDATE data.machine_daemons SET capabilities_json=capabilities_json||'["machine_routing_effort_v1"]'::jsonb`);
    await source("preview-declined");
    const declined = await launches.dispatchFromMessage({ commandId: "preview-declined", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "preview-declined", body,
      draftIntents: [{ start: 0, end: 6, mention: "@codex", choice: "explanation" }] },
      async () => assert.fail("a confirmed non-request allocates no launch and asks no question"));
    assert.equal(declined.selectionCount, 1);
    assert.deepEqual(declined.prepared, []);
    assert.equal(declined.rejected[0].code, "summon_intent_explanation");
    await source("dispatch-source");
    const dispatched = await launches.dispatchFromMessage({ commandId: "dispatch", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "dispatch-source", body,
      draftIntents: [{ start: 0, end: 6, mention: "@codex", choice: "summon" }] }, async ({ candidates, sourceSequence, summon }) => {
        assert.equal(summon.readInDraft, true);
        const boundary = await sql("SELECT timeline_sequence FROM data.messages WHERE message_id=$1", ["dispatch-source"]);
        assert.equal(sourceSequence, Number(boundary.rows[0].timeline_sequence));
        assert.deepEqual(candidates[0].observations.quota, { remainingPercent: 100, assumed: true });
        assert.deepEqual(candidates[0].parameters, [{ id: "serviceTier", label: "Service tier", options: ["future-priority"] }]);
        return { key: candidates[0].key, model: "model", workspaceReference: "workspace" };
      });
    assert.equal(dispatched.selectionCount, 1);
    assert.equal(dispatched.prepared.length, 1);
    const dispatchReplay = await launches.dispatchFromMessage({ commandId: "dispatch", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "dispatch-source", body }, async () => assert.fail("replay must not select again"));
    assert.equal(dispatchReplay.prepared[0].launchId, dispatched.prepared[0].launchId);
    assert.equal(dispatchReplay.prepared[0].reused, true);
    await sql(`UPDATE data.messages SET invocation_input_version=2,
      agent_invocation_targets_json=jsonb_set(agent_invocation_targets_json,'{selections,sourceRevision}','2')
      WHERE message_id='dispatch-source'`);
    await assert.rejects(launches.recoverFromMessage({ commandId: "dispatch:0", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "dispatch-source", selectionIndex: 0, body }),
      error => error.code === "registration_source_changed");
    assert.equal((await sql(`SELECT count(*)::int AS count FROM data.runs`)).rows[0].count, 5);
    const capabilityBody = "@codex task", capabilityHash = await digestCanonicalCloneCborV1(capabilityBody);
    await sql(`INSERT INTO data.messages VALUES ('space','channel','capability','user','caller',$1,1,1,1,$2,NULL,NULL,NULL)`,
      [capabilityHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: capabilityHash,
        selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "capability", harness: "codex" } }] } }]);
    await sql(`UPDATE control.agent_registration_environments SET declaration_json=declaration_json||'{"quotaPoolId":"pool"}'::jsonb`);
    await sql(`INSERT INTO control.registration_quota_observations VALUES
      ('owner','pool',0,statement_timestamp()-interval '1 second',statement_timestamp()+interval '5 minutes','provider')`);
    // An observation is current only for the connection that reported it.
    await sql(`UPDATE data.machine_daemons SET metadata_json=jsonb_build_object('machineResources',
      $1::jsonb||jsonb_build_object('connectionEpoch',connection_epoch))`, [{
      observedAt: new Date(Date.now() - 3_600_000).toISOString(), cpuLogicalCount: 8, cpuUsagePercent: 97,
      memoryTotalBytes: 10000, memoryAvailableBytes: 100 }]);
    const routed = await launches.dispatchFromMessage({ commandId: "capability", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "capability", body: capabilityBody }, async ({ candidates, tags }) => {
        assert.equal(Object.hasOwn(tags, "oneshot"), false);
        assert.equal(candidates[0].supportsRequestedEffort, true);
        assert.deepEqual(candidates[0].modelAliases, { model: "provider/model" });
        assert.equal(candidates[0].observations.quota.remainingPercent, 0);
        assert.equal(candidates[0].observations.quota.assumed, false);
        assert.equal(candidates[0].observations.quota.source, "provider");
        assert.equal(candidates[0].observations.machineResources.cpuUsagePercent, 97);
        assert.ok(candidates[0].observations.outstandingMachineAllocations >= 3);
        assert.deepEqual(candidates[0].modelCatalog, [{ model: "provider/model", description: "Observed model",
          efforts: [{ value: "high", description: "Thorough" }] }]);
        assert.deepEqual(candidates[0].workspaces, [{ reference: "workspace", canonicalCwd: "/repo", machineId: "machine", description: "Repo" }]);
        return { key: candidates[0].key, model: "model", effort: "high", workspaceReference: "workspace" };
      });
    assert.equal(routed.prepared.length, 1);
    const launchPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [routed.prepared[0].launchId])).rows[0].spawn_payload_json;
    assert.equal(launchPayload.exitAfterInitialMessage, undefined);
    assert.equal((await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`,
      [routed.prepared[0].runId])).rows[0].metadata_json.exitAfterInitialMessage, undefined);
    assert.equal((await sql(`SELECT count(*)::int AS count FROM data.runs`)).rows[0].count, 6);
    await source("resume-preparing");
    afterCommit = context => {
      if (context.operation === "registration.launch.stage") { afterCommit = undefined; throw new DatabaseCommitUnknownError("lost-stage-reply"); }
    };
    await assert.rejects(launches.prepare({ ...request, commandId: "resume-preparing", sourceMessageId: "resume-preparing" }),
      error => error.code === "database_commit_unknown");
    const staged = (await sql(`SELECT * FROM data.registration_launch_intents WHERE command_id='resume-preparing'`)).rows[0];
    assert.equal(staged.state, "preparing");
    const resumed = await launches.recoverFromMessage({ commandId: "resume-preparing", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "resume-preparing", selectionIndex: 0, body });
    assert.equal(resumed.launchId, staged.launch_id);
    const resumedPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`, [resumed.launchId])).rows[0].spawn_payload_json;
    assert.equal(resumedPayload.context.requestedEffort, "high");
    assert.equal(resumedPayload.exitAfterInitialMessage, undefined);
    assert.equal((await sql(`SELECT count(*)::int AS count FROM data.runs WHERE run_id=$1`, [resumed.runId])).rows[0].count, 1);

    // Any input launches with no source message; with no repository chosen it
    // works in a managed directory of its own.
    const inputBody = "Organize this Space";
    const managedChoice = async ({ candidates }) => ({ key: candidates[0].key, model: "model" });
    await assert.rejects(launches.dispatchInput({ commandId: "input-old-daemon", actorUserId: "caller", channelId: "channel",
      body: inputBody }, managedChoice),
    error => error.code === "registration_managed_route_unavailable", "a daemon without the capability is never sent one");
    await sql(`UPDATE data.machine_daemons SET capabilities_json=capabilities_json||'["registration_managed_v1"]'::jsonb`);
    const inputRequest = { commandId: "space-input", actorUserId: "caller", channelId: "channel", body: inputBody,
      runId: "run:space-input", instanceId: "instance:space-input" };
    const managed = await launches.dispatchInput(inputRequest, async ({ candidates, tags, managedWorkspace, sourceSequence }) => {
      assert.equal(managedWorkspace, true);
      assert.equal(sourceSequence, undefined);
      assert.deepEqual(tags, { });
      return { key: candidates[0].key, model: "model" };
    });
    assert.equal(managed.runId, "run:space-input");
    assert.equal(managed.instanceId, "instance:space-input");
    assert.equal(managed.agentName, "Codex");
    assert.equal(managed.hostId, "renamed-host");
    // Even when the source's quota reads healthy, its exact registration must
    // never be offered for its own usage-limit continuation.
    await assert.rejects(launches.dispatchInput({ commandId: "handoff-exclude-source", actorUserId: "owner",
      channelId: "channel", body: "continue", excludeSourceInstanceId: managed.instanceId },
    async () => assert.fail("the only registration is the excluded source")),
    error => error.code === "registration_not_found");
    await assert.rejects(launches.dispatchInput({ commandId: "handoff-other-owner", actorUserId: "caller",
      channelId: "channel", body: "continue", excludeSourceInstanceId: managed.instanceId },
    async () => assert.fail("another owner cannot name this predecessor")),
    error => error.code === "instance_not_found");
    const inputIntent = (await sql(`SELECT * FROM data.registration_launch_intents WHERE command_id='space-input'`)).rows[0];
    assert.equal(inputIntent.source_message_id, null);
    assert.equal(inputIntent.source_revision, null);
    const inputLaunch = (await sql(`SELECT trigger_id,spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [managed.launchId])).rows[0];
    assert.equal(inputLaunch.trigger_id, "space-input");
    const inputPayload = inputLaunch.spawn_payload_json;
    assert.equal(inputPayload.prompt, inputBody);
    assert.equal(inputPayload.sourceMessageId, undefined);
    assert.equal(inputPayload.context.initialMessageSource, undefined);
    assert.equal(inputPayload.exitAfterInitialMessage, undefined);
    assert.equal(inputPayload.remoteRepo, undefined);
    assert.match(inputPayload.workspace.canonicalCwd, /^\.xmatrix-management\/registration-/u);
    // An ordinary managed directory: the daemon places it by its key, and no
    // Space projection or management flag rides along.
    assert.equal(inputPayload.managementSpaceId, inputPayload.workspace.canonicalCwd.slice(".xmatrix-management/".length));
    assert.equal(inputPayload.workspace.metadata.syntheticManagedWorkspace, true);
    assert.equal(inputPayload.workspace.metadata.syntheticManagementWorkspace, undefined);
    assert.equal(inputPayload.workspace.metadata.managementProjectionKind, undefined);
    assert.deepEqual(inputPayload.registration.resources.workspaces, []);
    const inputRun = (await sql(`SELECT metadata_json FROM data.runs WHERE run_id='run:space-input'`)).rows[0].metadata_json;
    assert.equal(inputRun.routedAs, undefined);
    assert.equal(inputRun.managementSpaceId, undefined);
    assert.equal(inputRun.sourceMessageId, undefined);
    // The caller's own summon constrains the choice.
    let offeredTags;
    await launches.dispatchInput({ ...inputRequest, commandId: "input-constrained", runId: "run:input-constrained",
      instanceId: "instance:input-constrained", tags: { harness: "codex", model: "model" } },
    async ({ candidates, tags }) => { offeredTags = tags; return { key: candidates[0].key, model: "model" }; });
    assert.deepEqual(offeredTags, { harness: "codex", model: "model" });
    const inputReplay = await launches.dispatchInput(inputRequest, async () => assert.fail("replay must not select again"));
    assert.equal(inputReplay.launchId, managed.launchId);
    // #3270: work that needs GitHub runs only where the daemon shows a usable
    // GitHub login on its live connection. A capability no daemon can prove
    // (`node`) stays guidance and never refuses a launch.
    const githubRequest = { ...inputRequest, commandId: "needs-github", runId: "run:needs-github",
      instanceId: "instance:needs-github", requiredCapabilities: ["github", "node"] };
    await assert.rejects(launches.dispatchInput(githubRequest,
      async () => assert.fail("a machine that cannot show GitHub is never offered")),
    error => error.code === "registration_capability_unavailable");
    const showGithub = (capabilities) => sql(`UPDATE data.machine_daemons SET metadata_json=jsonb_set(metadata_json,
      '{machineResources,hostCapabilities}',$1::jsonb)`, [JSON.stringify(capabilities)]);
    await showGithub(["github"]);
    // The evidence is checked again at launch: it vanished after Jev chose.
    await assert.rejects(launches.dispatchInput({ ...githubRequest, commandId: "needs-github-lost",
      runId: "run:needs-github-lost", instanceId: "instance:needs-github-lost" }, async ({ candidates }) => {
      await showGithub([]);
      return { key: candidates[0].key, model: "model" };
    }), error => error.code === "registration_capability_unavailable");
    await showGithub(["github"]);
    const github = await launches.dispatchInput(githubRequest, managedChoice);
    assert.equal(github.runId, "run:needs-github");
    const githubIntent = (await sql(`SELECT launch_request_json FROM data.registration_launch_intents
      WHERE command_id='needs-github'`)).rows[0].launch_request_json;
    assert.deepEqual(githubIntent.requiredHostCapabilities, ["github"]);
    assert.equal(inputReplay.reused, true);
    await assert.rejects(launches.dispatchInput({ ...inputRequest, commandId: "input-retired-lifetime", oneshot: "off" },
      async () => assert.fail("retired input must not reach selection")),
    error => error.code === "invalid_registration_launch");

    // An input that answers a message acknowledges it; it is not a fence.
    const answer = await launches.dispatchInput({ commandId: "answer-1", actorUserId: "caller", channelId: "channel",
      body: "Wake up", initialMessageId: "message" }, managedChoice);
    assert.equal(answer.coalesced, undefined);
    const answerPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [answer.launchId])).rows[0].spawn_payload_json;
    assert.equal(answerPayload.sourceMessageId, "message", "the Run acknowledges the message it answers");
    assert.equal(answerPayload.context.initialMessageSource.messageId, "message");
    assert.equal(answerPayload.exitAfterInitialMessage, undefined);
    // A Channel About session: a background Run with no Channel Instance, one
    // per Channel, launched through ordinary registration with no Space
    // management configuration at all.
    assert.equal((await sql(`SELECT to_regclass('data.space_management_configs') AS t`)).rows[0].t, null);
    const aboutRequest = { commandId: "about-1", actorUserId: "caller", channelId: "channel", body: "Refresh About",
      runMetadata: { routedAs: "management_channel_about", managementSpaceId: "space" },
      aboutSession: { triggerRequestId: "about-trigger-1" } };
    const about = await launches.dispatchInput(aboutRequest, async ({ candidates, tags, managedWorkspace }) => {
      assert.equal(managedWorkspace, true);
      assert.deepEqual(tags, { });
      assert.deepEqual(candidates[0].workspaces, [], "an About session is never offered a repository");
      return { key: candidates[0].key, model: "model" };
    });
    // Its key is the Channel's k-th About Run, which also stands in the Instance slot.
    assert.equal(about.runId, "channel:about#1");
    assert.equal(about.instanceId, about.runId);
    assert.equal((await sql(`SELECT count(*)::int AS count FROM data.instances WHERE instance_id=$1`, [about.instanceId])).rows[0].count, 0);
    const aboutRun = (await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`, [about.runId])).rows[0].metadata_json;
    assert.equal(aboutRun.runtimeSessionId, about.instanceId);
    assert.equal(aboutRun.channelWriteAllowed, false);
    assert.equal(aboutRun.channelAboutPendingRequestId, "about-trigger-1");
    assert.equal(aboutRun.routedAs, "management_channel_about");
    assert.equal(aboutRun.managementSpaceId, "space");
    assert.equal(aboutRun.managementConfigGeneration, undefined);
    const aboutPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`, [about.launchId])).rows[0].spawn_payload_json;
    assert.equal(aboutPayload.registration.instanceId, about.instanceId);
    // Its private directory reads its Channel on demand under its real Space id.
    assert.equal(aboutPayload.managementSpaceId, "space");
    assert.equal(aboutPayload.remoteRepo, undefined);
    assert.equal(aboutPayload.sourceMessageId, undefined);
    assert.equal(aboutPayload.workspace.metadata.syntheticManagementWorkspace, true);
    assert.equal(aboutPayload.workspace.metadata.managementProjectionKind, "channel",
      "an About session reads on demand; released daemons mirror no Space for it");
    assert.equal(aboutPayload.workspace.metadata.syntheticManagedWorkspace, undefined);
    assert.match(aboutPayload.workspace.canonicalCwd, /^\.xmatrix-management\/registration-/u);
    assert.deepEqual(aboutPayload.registration.resources.workspaces, []);
    const joined = await launches.dispatchInput({ ...aboutRequest, commandId: "about-2",
      aboutSession: { triggerRequestId: "about-trigger-2" } }, async () => assert.fail("a serving session needs no selection"));
    assert.equal(joined.coalesced, true);
    assert.equal(joined.runId, about.runId);
    assert.equal((await sql(`SELECT metadata_json->>'channelAboutPendingRequestId' AS pending FROM data.runs WHERE run_id=$1`,
      [about.runId])).rows[0].pending, "about-trigger-2", "the new trigger waits as the session's pending refresh");
    await assert.rejects(launches.dispatchInput({ ...aboutRequest, commandId: "about-successor-wrong",
      aboutSession: { triggerRequestId: "about-trigger-9", successorOfRunId: about.runId } }, managedChoice),
    error => error.code === "about_successor_mismatch", "a successor follows only a terminal predecessor");
    // A session that finished its turn reads no further trigger: the next one
    // starts a fresh session and hands the finished one back for its daemon to end.
    await sql(`UPDATE data.runs SET status='running',
      metadata_json=metadata_json || '{"invocationProgress":{"phase":"turn_completed"}}'::jsonb WHERE run_id=$1`, [about.runId]);
    // An About session works only in its private directory: a location
    // condition or a chosen repository is refused before anything launches.
    await assert.rejects(launches.dispatchInput({ ...aboutRequest, commandId: "about-located", tags: { pwd: "/repo" },
      aboutSession: { triggerRequestId: "about-trigger-located" } },
    async () => assert.fail("a refused constraint never reaches selection")),
    error => error.code === "invalid_registration_launch");
    await assert.rejects(launches.dispatchInput({ ...aboutRequest, commandId: "about-repo",
      aboutSession: { triggerRequestId: "about-trigger-repo" } },
    async ({ candidates }) => ({ key: candidates[0].key, model: "model", workspaceReference: "workspace" })),
    error => error.code === "registration_selection_invalid");
    const fresh = await launches.dispatchInput({ ...aboutRequest, commandId: "about-3",
      aboutSession: { triggerRequestId: "about-trigger-3" } }, managedChoice);
    assert.equal(fresh.coalesced, undefined);
    assert.equal(fresh.runId, "channel:about#2");
    const finished = (await sql(`SELECT r.status, r.metadata_json, b.owner_user_id FROM data.runs r
      JOIN data.run_agent_registrations b ON b.run_id=r.run_id WHERE r.run_id=$1`, [about.runId])).rows[0];
    assert.equal(finished.status, "running", "a reported phase never terminalizes the Run; its daemon does");
    assert.deepEqual(fresh.retiredAboutSessions, [{ runId: about.runId, channelId: "channel", sessionId: about.instanceId,
      machineOwnerUserId: finished.owner_user_id, machineId: finished.metadata_json.machineId,
      hostId: finished.metadata_json.hostname, executionKey: finished.metadata_json.executionKey }]);
    const nextTrigger = await launches.dispatchInput({ ...aboutRequest, commandId: "about-4",
      aboutSession: { triggerRequestId: "about-trigger-4" } }, async () => assert.fail("the fresh session serves"));
    assert.equal(nextTrigger.coalesced, true);
    assert.equal(nextTrigger.runId, fresh.runId);
    assert.equal(nextTrigger.retiredAboutSessions.length, 1, "the finished session is handed back until it ends");

    await sql(`UPDATE data.space_agent_registrations SET configuration_json=jsonb_set(configuration_json,
      '{workspaceReferences}','["workspace","repo:owner/project"]')`);
    await sql(`UPDATE data.space_agent_registration_access SET
      grant_limits=jsonb_set(grant_limits,'{workspaces}','["workspace","repo:owner/project"]'),
      policy_limits=jsonb_set(policy_limits,'{workspaces}','["workspace","repo:owner/project"]')`);
    // A repository launch needs no connector check; GitHub gates the clone.
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ('space','space:github',1,'github','GitHub','configured','oauth','[]','[]','[]','[]','owner','repo-catalog',now(),now())`);
    const repoBody = "@codex repo:owner/project", repoHash = await digestCanonicalCloneCborV1(repoBody);
    await sql(`INSERT INTO data.messages VALUES ('space','channel','repository','user','caller',$1,1,1,1,$2,NULL,NULL,NULL)`,
      [repoHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: repoHash,
        selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "capability", harness: "codex" } }] } }]);
    const repository = await launches.dispatchFromMessage({ commandId: "repository", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "repository", body: repoBody }, async ({ candidates }) => {
        assert.deepEqual(candidates[0].workspaces.find(item => item.repo), { reference: "repo:owner/project", repo: "owner/project",
          machineId: "machine", description: "Authorized registered repository" });
        return { key: candidates[0].key, model: "model", workspaceReference: "repo:owner/project" };
      });
    assert.equal(repository.prepared.length, 1);
    const repoPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [repository.prepared[0].launchId])).rows[0].spawn_payload_json;
    assert.equal(repoPayload.remoteRepo, "owner/project");
    assert.equal(repoPayload.runWorktree, true);
    assert.equal(repoPayload.prompt, repoBody);
    assert.match(repoPayload.workspace.managedKey, /^registration-[a-f0-9]{48}$/);
    const repoRun = (await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`,
      [repository.prepared[0].runId])).rows[0].metadata_json;
    assert.equal(repoRun.managedWorkspaceKey, repoPayload.workspace.managedKey);
    assert.equal(repoRun.resumeSessionKey, repoPayload.resumeSessionKey);
    assert.notEqual(repoRun.resumeSessionKey, sessionKey);
    assert.deepEqual(repoPayload.registration.resources.workspaces, ["repo:owner/project"]);
    assert.equal(Number((await sql("SELECT count(*) FROM data.workspaces WHERE workspace_id='repo:owner/project'")).rows[0].count), 0);
    assert.equal((await capacity.admit({ requestId: "repository-admission", key,
      runId: repository.prepared[0].runId, allocationId: repoPayload.registration.allocationId,
      authorizationDigest: repoPayload.registration.authorizationDigest, daemonId: "daemon", connectionEpoch: 1, hostId: "host",
      expectedEnvironmentVersion: repoPayload.registration.environmentVersion,
      expectedRuntimeModel: repoPayload.registration.runtimeModel })).state, "admitted");
    const invalidRepo = await launches.dispatchFromMessage({ commandId: "ungranted-repository", actorUserId: "caller",
      channelId: "channel", sourceMessageId: "repository", body: repoBody }, async ({ candidates }) => ({
        key: candidates[0].key, model: "model", workspaceReference: "repo:other/project" }));
    assert.equal(invalidRepo.prepared.length, 0);
    assert.equal(invalidRepo.rejected[0].code, "registration_selection_invalid");
    for (const messageId of ['runtime-default-old-source', 'runtime-default-source']) {
      await sql(`INSERT INTO data.messages SELECT space_id,channel_id,$1,author_kind,author_id,body_hash,
        entity_version,invocation_input_version,timeline_sequence,agent_invocation_targets_json,edited_at,deleted_at,recalled_at
        FROM data.messages WHERE message_id='repository'`, [messageId]);
    }
    const defaultInput = { commandId: 'runtime-default-before-upgrade', actorUserId: 'caller',
      channelId: 'channel', sourceMessageId: 'runtime-default-old-source', body: repoBody };
    const chooseDefault = async ({ candidates }) => ({ key: candidates[0].key, model: '',
      workspaceReference: 'repo:owner/project', useRuntimeDefaultModel: true });
    const unsupportedDefault = await launches.dispatchFromMessage(defaultInput, chooseDefault);
    assert.equal(unsupportedDefault.prepared.length, 0, 'old daemons cannot silently restore the override');
    await sql(`UPDATE data.machine_daemons SET capabilities_json=capabilities_json || '["registration_optional_model_v1"]'::jsonb`);
    const defaultRequest = { ...defaultInput, commandId: 'runtime-default', sourceMessageId: 'runtime-default-source' };
    const defaultLaunch = await launches.dispatchFromMessage(defaultRequest, chooseDefault);
    assert.equal(defaultLaunch.prepared.length, 1);
    const defaultPayload = (await sql(`SELECT spawn_payload_json FROM data.agent_launches WHERE launch_id=$1`,
      [defaultLaunch.prepared[0].launchId])).rows[0].spawn_payload_json;
    assert.equal(Object.hasOwn(defaultPayload.context, 'requestedModel'), false);
    assert.equal(Object.hasOwn(defaultPayload.context, 'requestedEffort'), false);
    assert.equal(defaultPayload.registration.runtimeModel, undefined, 'no synthetic model identity is admitted');
    const defaultReplay = await launches.dispatchFromMessage(defaultRequest, async () => assert.fail('replay must preserve the default selection'));
    assert.equal(defaultReplay.prepared[0].launchId, defaultLaunch.prepared[0].launchId);
    const beforeFailure = Number((await sql('SELECT count(*) AS count FROM data.runs')).rows[0].count);
    for (const code of ['registration_selection_failed', 'registration_context_unavailable',
      'registration_directory_unavailable', 'registration_environment_jev_rate_limited',
      'registration_parameter_jev_auth_failed']) {
      const failure = await launches.dispatchFromMessage({ commandId: `model-outage-${code}`, actorUserId: "caller",
        channelId: "channel", sourceMessageId: "repository", body: repoBody }, async () => {
          throw code === 'registration_selection_failed' ? new Error('private provider payload') : new RegistrationAccessError(code, 503);
        });
      assert.equal(failure.prepared.length, 0);
      assert.equal(failure.rejected[0].code, code);
      assert.ok(repoBody.includes(failure.rejected[0].sourceMention));
      assert.doesNotMatch(JSON.stringify(failure), /private provider/);
      assert.equal(Number((await sql('SELECT count(*) AS count FROM data.runs')).rows[0].count), beforeFailure);
    }

    for (const [name, disable, restore] of [
      ["physical-disabled", `UPDATE control.agent_registration_environments SET declaration_json=jsonb_set(declaration_json,'{enabled}','false')`,
        `UPDATE control.agent_registration_environments SET declaration_json=jsonb_set(declaration_json,'{enabled}','true')`],
      ["physical-expired", `UPDATE control.agent_registration_environments SET declaration_json=jsonb_set(declaration_json,'{availableUntil}','"2000-01-01T00:00:00Z"')`,
        `UPDATE control.agent_registration_environments SET declaration_json=declaration_json-'availableUntil'`],
      ["space-disabled", `UPDATE data.space_agent_registrations SET configuration_json=jsonb_set(configuration_json,'{routing,enabled}','false')`,
        `UPDATE data.space_agent_registrations SET configuration_json=jsonb_set(configuration_json,'{routing,enabled}','true')`],
      ["physical-model-removed", `UPDATE control.agent_registration_environments SET declaration_json=declaration_json || '{"models":["other"],"modelAliases":{"other":"provider/other"}}'::jsonb`,
        `UPDATE control.agent_registration_environments SET declaration_json=declaration_json || '{"models":["model"],"modelAliases":{"model":"provider/model"}}'::jsonb`],
    ]) {
      await sql(disable);
      const failure = await launches.dispatchFromMessage({ commandId: name, actorUserId: "caller", channelId: "channel",
        sourceMessageId: "repository", body: repoBody }, async () => assert.fail("ineligible registration reached Jev"));
      assert.deepEqual(failure.prepared, []);
      assert.equal(failure.rejected[0].code, "registration_not_found");
      await sql(restore);
    }

    // Reborn keeps the Instance id, ordinal and harness session; its successor
    // is a registration Run of the same tuple, created only after the
    // predecessor's confirmed stop.
    // A registered Instance is found for reborn by its registration's name.
    const { PostgresRuntimeRepository } = await import("../dist/runtime-control.js");
    const control = await readFile(new URL("../migrations/0011_expand_space_control_authority.sql", import.meta.url), "utf8");
    await sql(control.match(/CREATE TABLE control\.channel_space_directory \([\s\S]*?\n\);/u)[0]);
    await sql(`INSERT INTO control.postgres_shards VALUES ('test','active','test',now(),now());
      INSERT INTO control.space_placement VALUES ('space','test',1,'active',NULL,'test',now(),now());
      INSERT INTO control.channel_space_routes VALUES ('channel','space','test',1,1,'active',now())`);
    const rebornTarget = await new PostgresRuntimeRepository(database).getChannelAgentRebornTarget({ requestId: "reborn-target",
      channelId: "channel", agentName: "Codex", channelInstanceId: Number((await sql(`SELECT channel_instance_id FROM data.instances
        WHERE instance_id=$1`, [replay.instanceId])).rows[0].channel_instance_id), actorUserId: "caller" }).catch(error => error);
    assert.equal(rebornTarget.target?.instanceId, replay.instanceId, String(rebornTarget.message ?? ""));
    assert.equal(rebornTarget.target.agentName, "Codex");
    // `/kill all` and `@agent:kill` read this list: a registered Instance has no
    // Profile, and must still be listed, addressed and stoppable as itself.
    const killTargets = await new PostgresRuntimeRepository(database).listChannelAgentKillTargets({
      requestId: "kill-targets", channelId: "channel", actorUserId: "caller" }).catch(error => error);
    const registeredTarget = killTargets.targets?.find(target => target.instanceId === replay.instanceId);
    assert.ok(registeredTarget, `registered Instance is a kill target: ${String(killTargets.message ?? JSON.stringify(killTargets))}`);
    assert.equal(registeredTarget.agentId, replay.instanceId);
    assert.equal(registeredTarget.runId, replay.runId);
    assert.equal(registeredTarget.mentionTarget, `Codex:${rebornTarget.target.channelInstanceId}`);
    assert.equal(registeredTarget.machineOwnerUserId, key.ownerUserId);
    assert.equal(registeredTarget.machineId, "machine");
    assert.equal(registeredTarget.hostId, "renamed-host");
    const reborn = new PostgresRegistrationRebornRepository(database, database, placement);
    const before = (await sql(`SELECT instance_id,channel_instance_id FROM data.instances WHERE instance_id=$1`, [replay.instanceId])).rows[0];
    const prepared = await reborn.prepare({ commandId: "reborn", actorUserId: "caller", channelId: "channel",
      sourceMessageId: "message", sourceInstanceId: replay.instanceId, prompt: "continue" });
    assert.equal(prepared.state, "waiting");
    assert.equal((await reborn.prepare({ commandId: "reborn", actorUserId: "caller", channelId: "channel",
      sourceMessageId: "message", sourceInstanceId: replay.instanceId, prompt: "continue" })).reused, true);
    assert.equal((await reborn.advance({ intentId: prepared.intentId, actorUserId: "caller", channelId: "channel" })).state, "waiting",
      "the successor waits for the predecessor's confirmed stop");
    const intent = (await sql(`SELECT * FROM data.agent_reborn_intents WHERE intent_id=$1`, [prepared.intentId])).rows[0];
    assert.equal(intent.stop_payload_json.agentId, replay.instanceId, "a registered predecessor is stopped as its Instance");
    const predecessor = (await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`, [replay.runId])).rows[0].metadata_json;
    await sql(`UPDATE data.runs SET status='stopped',metadata_json=metadata_json||$2::jsonb WHERE run_id=$1`, [replay.runId,
      { daemonStopEvidence: { schemaVersion: 1, kind: "stop_succeeded", runId: replay.runId, executionKey: predecessor.executionKey,
        machineId: "machine", hostId: "host", controlId: intent.stop_control_id, completedAt: new Date().toISOString() } }]);
    const advanced = await reborn.advance({ intentId: prepared.intentId, actorUserId: "caller", channelId: "channel" });
    assert.equal(advanced.state, "prepared");
    const successor = (await sql(`SELECT * FROM data.runs WHERE run_id=$1`, [prepared.intentId])).rows[0];
    assert.equal(successor.metadata_json.resumeSessionKey, predecessor.resumeSessionKey);
    assert.equal((await sql(`SELECT count(*)::int AS count FROM data.run_agent_registrations WHERE run_id=$1`, [prepared.intentId])).rows[0].count, 1);
    const after = (await sql(`SELECT * FROM data.instances WHERE instance_id=$1`, [replay.instanceId])).rows[0];
    assert.equal(after.run_id, prepared.intentId);
    assert.equal(after.channel_instance_id, before.channel_instance_id);
    assert.deepEqual(advanced.spawnPayload.registration.key, key);
    assert.equal(advanced.spawnPayload.registration.instanceId, replay.instanceId);
    assert.equal(advanced.spawnPayload.identityId, replay.instanceId);
    assert.equal(advanced.spawnPayload.resume, true);
    assert.equal(advanced.spawnPayload.context.requestedModel, "provider/model");
    // The reborn answers its own message; the backlog from while it was stopped is not replayed to it.
    const head = (await sql(`SELECT MAX(timeline_sequence)::bigint AS sequence FROM data.messages
      WHERE space_id='space' AND channel_id='channel'`)).rows[0].sequence;
    const cursor = (await sql(`SELECT acknowledged_sequence FROM data.delivery_cursors
      WHERE space_id='space' AND subject_id=$1 AND channel_id='channel'`, [`agent:${replay.instanceId}`])).rows[0];
    assert.equal(String(cursor?.acknowledged_sequence), String(head));
    const cold = await launches.dispatchInput({ commandId: 'local-runtime-default', actorUserId: 'caller',
      channelId: 'channel', body: 'Continue in the registered directory' }, async ({ candidates }) => ({
        key: candidates[0].key, model: '', workspaceReference: 'workspace', useRuntimeDefaultModel: true }));
    await sql(`UPDATE data.runs SET status='failed' WHERE run_id=$1`, [cold.runId]);
    // While the machine's daemon is offline the refusal says so, rather than
    // suggesting a missing Workspace, and a later message can still wake it.
    await sql(`UPDATE data.machine_daemons SET status='offline'`);
    await assert.rejects(() => reborn.prepare({ commandId: 'default-reborn-offline', actorUserId: 'caller', channelId: 'channel',
      sourceMessageId: 'repository', sourceInstanceId: cold.instanceId, prompt: 'continue' }),
    error => error.code === 'registration_daemon_offline' && error.status === 409);
    await sql(`UPDATE data.machine_daemons SET status='online'`);
    const defaultReborn = await reborn.prepare({ commandId: 'default-reborn', actorUserId: 'caller', channelId: 'channel',
      sourceMessageId: 'repository', sourceInstanceId: cold.instanceId, prompt: 'continue' });
    const coldSuccessor = await reborn.advance({ intentId: defaultReborn.intentId, actorUserId: 'caller', channelId: 'channel' });
    assert.equal(coldSuccessor.state, 'prepared');
    assert.equal(Object.hasOwn(coldSuccessor.spawnPayload.context, 'requestedModel'), false);
    assert.equal(Object.hasOwn(coldSuccessor.spawnPayload.context, 'requestedEffort'), false);

    // Handoff moves an Instance's directory to another harness on the same
    // machine. Its successor is a new Instance, and the predecessor is fenced
    // in the same statement that stamps when it moved.
    const grokKey = { ...key, harness: "grok" };
    await sql(`INSERT INTO data.agent_registrations VALUES ('owner','machine','grok',1,now(),now());
      INSERT INTO data.space_agent_registrations VALUES ('space','owner','machine','grok','Grok',
        '{"workspaceReferences":["workspace"],"secretReferences":[],"model":"model","routing":{"schemaVersion":1,"enabled":true,"models":["model"],"description":"test","maxConcurrent":4}}',1,now(),now())`);
    await access.change({ key: grokKey, actorUserId: "owner", commandId: "grant-grok", expectedRevision: 1, state: "active", limits });
    const { spaceId: _grokSpace, ...grokPhysical } = grokKey;
    await new PostgresAgentEnvironmentRepository(database).change({ key: grokPhysical, actorUserId: "owner",
      commandId: "environment-grok", expectedVersion: 0, expectedMachineVersion: 1, machineMaxConcurrent: 4,
      environment: { schemaVersion: 1, enabled: true, models: ["model"], modelAliases: { model: "provider/model" },
        description: "", availability: "unattended", maxConcurrent: 4, capabilities: [],
        launch: { runtime: "/opt/grok/bin/grok", runtimeArgs: [] } } });
    const handoffSource = await launches.dispatchInput({ commandId: "handoff-source", actorUserId: "caller",
      channelId: "channel", body: "Work in the registered directory" }, async ({ candidates }) => ({
        key: candidates.find(candidate => candidate.key.harness === "codex").key, model: "model",
        workspaceReference: "workspace" }));
    await sql(`UPDATE data.runs SET status='running' WHERE run_id=$1`, [handoffSource.runId]);
    const handoff = await reborn.prepareHandoff({ commandId: "handoff", actorUserId: "caller", channelId: "channel",
      sourceMessageId: "message", sourceInstanceId: handoffSource.instanceId, successorHarness: "grok", prompt: "continue" });
    assert.equal(handoff.state, "waiting");
    const handoffIntent = (await sql(`SELECT * FROM data.agent_reborn_intents WHERE intent_id=$1`, [handoff.intentId])).rows[0];
    const handoffPredecessor = (await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`, [handoffSource.runId])).rows[0].metadata_json;
    await sql(`UPDATE data.runs SET status='stopped',metadata_json=metadata_json||$2::jsonb WHERE run_id=$1`, [handoffSource.runId,
      { daemonStopEvidence: { schemaVersion: 1, kind: "stop_succeeded", runId: handoffSource.runId,
        executionKey: handoffPredecessor.executionKey, machineId: "machine", hostId: "host",
        controlId: handoffIntent.stop_control_id, completedAt: new Date().toISOString() } }]);
    const handedOff = await reborn.advance({ intentId: handoff.intentId, actorUserId: "caller", channelId: "channel" });
    assert.equal(handedOff.state, "prepared");
    assert.notEqual(handedOff.instanceId, handoffSource.instanceId, "a handoff successor is a new Instance");
    const fencedSource = (await sql(`SELECT metadata_json,updated_at FROM data.runs WHERE run_id=$1`, [handoffSource.runId])).rows[0];
    assert.equal(fencedSource.metadata_json.instanceHandoff.successorInstanceId, handedOff.instanceId);
    assert.equal(fencedSource.updated_at.toISOString(), fencedSource.metadata_json.instanceHandoff.transferredAt);
    assert.equal((await sql(`SELECT harness FROM data.run_agent_registrations WHERE run_id=$1`, [handedOff.runId])).rows[0].harness, "grok");
    // The same message interpreted again (a replayed post, a usage limit
    // reported again) gets its own handoff back; another message is refused.
    const replayed = { commandId: "handoff-replay", actorUserId: "caller", channelId: "channel",
      sourceMessageId: "message", sourceInstanceId: handoffSource.instanceId, prompt: "continue" };
    assert.deepEqual(await reborn.prepareHandoff({ ...replayed, successorHarness: "grok" }),
      { entityId: handedOff.instanceId, intentId: handoff.intentId, state: "prepared", reused: true });
    assert.deepEqual(await reborn.prepareAutoHandoff(replayed),
      { outcome: "handed_off", intentId: handoff.intentId, state: "prepared", refusals: [] });
    assert.equal((await reborn.prepareAutoHandoff({ ...replayed, sourceMessageId: "another" })).outcome,
      "source_transferred");



    // Connector repositories and machine directories are alternative locations.
    // No repo is copied into registration configuration, owner grant or policy.
    let catalogEnabled = true;
    const catalog = { repositories: ['owner/shared'] };
    let catalogReads = 0;
    const readRepositories = async actor => { catalogReads++; assert.equal(actor, 'caller'); return catalogEnabled ? catalog : undefined; };
    const connectorLaunches = new PostgresRegistrationLaunchRepository(database, database, placement, readRepositories);
    const connectorBody = '@codex repo:owner/shared';
    const connectorHash = await digestCanonicalCloneCborV1(connectorBody);
    await sql(`INSERT INTO data.messages VALUES ('space','channel','connector-repository','user','caller',$1,1,1,1,$2,NULL,NULL,NULL)`,
      [connectorHash, { selections: { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: connectorHash,
        selections: [{ start: 0, end: 6, text: '@codex', target: { kind: 'capability', harness: 'codex' } }] } }]);
    const beforeConfig = (await sql(`SELECT configuration_json FROM data.space_agent_registrations`)).rows;
    const beforeAccess = (await sql(`SELECT grant_limits,policy_limits,grant_revision,policy_revision FROM data.space_agent_registration_access`)).rows;
    const connectorInput = { commandId: 'connector-repository', actorUserId: 'caller', channelId: 'channel',
      sourceMessageId: 'connector-repository', body: connectorBody };
    const connected = await connectorLaunches.dispatchFromMessage(connectorInput, async ({ candidates }) => {
      assert.ok(candidates[0].workspaces.some(item => item.reference === 'workspace' && item.canonicalCwd === '/repo'));
      assert.ok(candidates[0].workspaces.some(item => item.reference === 'repo:owner/shared' && item.repo === 'owner/shared'));
      assert.ok(!candidates[0].workspaces.some(item => item.reference === 'repo:owner/project'), 'connector is the repo source');
      return { key: candidates[0].key, model: 'model', workspaceReference: 'repo:owner/shared' };
    });
    assert.equal(connected.prepared.length, 1);
    assert.equal(catalogReads, 0, 'a summon naming its repo reads no catalog');
    assert.deepEqual((await sql(`SELECT configuration_json FROM data.space_agent_registrations`)).rows, beforeConfig);
    assert.deepEqual((await sql(`SELECT grant_limits,policy_limits,grant_revision,policy_revision FROM data.space_agent_registration_access`)).rows, beforeAccess);
    const connectorRun = connected.prepared[0];
    assert.equal((await connectorLaunches.dispatchFromMessage(connectorInput, async () => assert.fail('replay'))).prepared[0].runId, connectorRun.runId);
    const { requireRunRegistrationAccess } = await import('../dist/agent-registration-run.js');
    const readAdmission = () => database.transaction({}, tx => requireRunRegistrationAccess(tx, { runId: connectorRun.runId,
      channelId: 'channel', phase: 'admission', error: (code, status) => new RegistrationAccessError(code, status) }));
    assert.deepEqual((await readAdmission()).resources.workspaces, ['repo:owner/shared']);
    // A repo-launched Instance reborns into the exact pool slot it ran in. The
    // daemon reported that slot on the predecessor's spawn; dropping it sent
    // the successor to a fresh worktree whose harness refused the session.
    const repoRunId = repository.prepared[0].runId;
    const repoInstanceId = (await sql(`SELECT instance_id FROM data.instances WHERE run_id=$1`, [repoRunId])).rows[0].instance_id;
    const repoPredecessor = (await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`, [repoRunId])).rows[0].metadata_json;
    const repoPool = { repoIdentity: "github.com/owner/project", repoKeyId: "b".repeat(64), slotId: "c".repeat(32) };
    const repoReborn = { commandId: "repo-reborn", actorUserId: "caller", channelId: "channel",
      sourceMessageId: "repository", sourceInstanceId: repoInstanceId, prompt: "continue" };
    await sql(`UPDATE data.runs SET metadata_json=metadata_json||$2::jsonb WHERE run_id=$1`,
      [repoRunId, { repoPool: { ...repoPool, slotId: "not-a-slot" } }]);
    await assert.rejects(() => reborn.prepare(repoReborn), error => error.code === "registration_reborn_repo_pool_invalid",
      "a malformed retained slot is refused, never dropped in favor of a new tree");
    await sql(`UPDATE data.runs SET metadata_json=metadata_json||$2::jsonb WHERE run_id=$1`, [repoRunId, { repoPool }]);
    const repoPrepared = await reborn.prepare(repoReborn);
    assert.equal(repoPrepared.state, "waiting");
    const repoIntent = (await sql(`SELECT * FROM data.agent_reborn_intents WHERE intent_id=$1`, [repoPrepared.intentId])).rows[0];
    assert.equal(repoIntent.stop_payload_json.worktreeDisposition, "retain", "the predecessor's slot is kept for its successor");
    for (const payload of [repoIntent.spawn_payload_json]) {
      assert.equal(payload.remoteRepo, "owner/project");
      assert.equal(payload.runWorktree, true);
      assert.equal(payload.resume, true);
      assert.equal(payload.resumeInstanceId, repoInstanceId);
      assert.equal(payload.resumeSessionKey, repoPredecessor.resumeSessionKey);
      assert.deepEqual({ repoIdentity: payload.repoIdentity, repoKeyId: payload.repoKeyId, slotId: payload.slotId }, repoPool);
    }
    await sql(`UPDATE data.runs SET status='stopped',metadata_json=metadata_json||$2::jsonb WHERE run_id=$1`, [repoRunId,
      { daemonStopEvidence: { schemaVersion: 1, kind: "stop_succeeded", runId: repoRunId, executionKey: repoPredecessor.executionKey,
        machineId: "machine", hostId: "host", controlId: repoIntent.stop_control_id, completedAt: new Date().toISOString() } }]);
    const repoAdvanced = await reborn.advance({ intentId: repoPrepared.intentId, actorUserId: "caller", channelId: "channel" });
    assert.equal(repoAdvanced.state, "prepared");
    assert.deepEqual({ repoIdentity: repoAdvanced.spawnPayload.repoIdentity, repoKeyId: repoAdvanced.spawnPayload.repoKeyId,
      slotId: repoAdvanced.spawnPayload.slotId }, repoPool, "the dispatched spawn leases back the exact retained slot");
    assert.deepEqual(repoAdvanced.spawnPayload.registration.resources.workspaces, ["repo:owner/project"]);

    // The connection changing or disconnecting does not touch a repo Run: no
    // authorization was pinned to it, and GitHub alone gates the clone.
    await sql(`UPDATE data.app_connector_connections SET version=2,status='disconnected'`);
    catalogEnabled = false;
    assert.deepEqual((await readAdmission()).resources.workspaces, ['repo:owner/shared']);
    const replayedAfterDisconnect = await connectorLaunches.dispatchFromMessage(connectorInput, async () => assert.fail("replay"));
    assert.equal(replayedAfterDisconnect.prepared[0].runId, connectorRun.runId);
    assert.equal(Object.hasOwn((await sql(`SELECT metadata_json FROM data.runs WHERE run_id=$1`, [connectorRun.runId]))
      .rows[0].metadata_json, 'connectorRepositoryAuthorization'), false, 'no connector authorization is stored');
    const localAfterDisconnect = await connectorLaunches.dispatchInput({ commandId: 'cwd-after-disconnect', actorUserId: 'caller',
      channelId: 'channel', body: 'Use existing local state' }, async ({ candidates }) => {
      assert.ok(candidates[0].workspaces.some(item => item.reference === 'workspace'));
      assert.ok(!candidates[0].workspaces.some(item => item.repo));
      return { key: candidates[0].key, model: 'model', workspaceReference: 'workspace' };
    });
    assert.ok(localAfterDisconnect.runId);

    // A resting Instance wakes for the next message in its Channel, resumed as
    // its owner through a `wake` continuation (docs/instance-sleep.md §3).
    const sleeper = localAfterDisconnect;
    const repoSleeper = connectorRun;
    // A Run launched while connector authorizations were stored still wakes.
    await sql(`UPDATE data.runs SET metadata_json=metadata_json||$2::jsonb WHERE run_id=$1`, [repoSleeper.runId,
      { connectorRepositoryAuthorization: { connectionId: 'space:github', connectionVersion: 1, repository: 'owner/shared' } }]);
    for (const target of [sleeper, repoSleeper]) {
      await sql(`UPDATE data.runs SET status='exited' WHERE run_id=$1`, [target.runId]);
      await sql(`UPDATE data.instances SET status='offline',rest_state='sleeping' WHERE instance_id=$1`, [target.instanceId]);
    }
    const woke = await reborn.wakeResting({ commandId: "wake-message", channelId: "channel", sourceMessageId: "message",
      prompt: "what was the codeword?" });
    assert.deepEqual(woke.woken.map(item => item.instanceId).sort(), [sleeper.instanceId, repoSleeper.instanceId].sort());
    assert.deepEqual(woke.refused, [], "a repo Instance wakes whatever its Space's GitHub connection state");
    const repoWake = (await sql(`SELECT * FROM data.agent_reborn_intents WHERE intent_id=$1`,
      [woke.woken.find(item => item.instanceId === repoSleeper.instanceId).intentId])).rows[0];
    assert.equal(repoWake.spawn_payload_json.remoteRepo, 'owner/shared');
    assert.equal(Object.hasOwn(repoWake.run_input_json.metadata, 'connectorRepositoryAuthorization'), false);
    const wakeIntent = (await sql(`SELECT * FROM data.agent_reborn_intents WHERE intent_id=$1`,
      [woke.woken.find(item => item.instanceId === sleeper.instanceId).intentId])).rows[0];
    await assert.rejects(new PostgresRuntimeRepository(database).stopRestingInstances({ requestId: "handoff-pending-wake",
      channelId: "channel", actorUserId: "caller", handoffSource: { instanceId: sleeper.instanceId, runId: sleeper.runId } }),
      error => error.code === "reborn_pending", "a pending wake must refuse the cross-machine handoff");
    assert.equal(wakeIntent.actor_user_id, "owner", "a wake acts as the Instance's owner, whoever posted");
    assert.equal(wakeIntent.stop_required, false, "a resting predecessor has no process to stop");
    assert.equal(wakeIntent.kind, "wake", "a wake is recorded as a wake, not a reborn");
    assert.equal(wakeIntent.run_input_json.invocationSource, undefined, "a wake answers no message");
    // An Instance that never acknowledged a delivery has a catch-up floor of 0,
    // which replays nothing: the waking message must be its first prompt.
    assert.equal(wakeIntent.spawn_payload_json.prompt, "what was the codeword?");
    assert.equal(wakeIntent.spawn_payload_json.sourceMessageId, "message",
      "a catch-up copy of the waking message is dropped as the summon echo");
    assert.equal(wakeIntent.run_input_json.metadata.sourceMessageId, "message");
    assert.equal(wakeIntent.spawn_payload_json.resume, true);
    // A second message finds the sleeper already waking and wakes nobody.
    const again = await reborn.wakeResting({ commandId: "wake-again", channelId: "channel", sourceMessageId: "repository" });
    assert.deepEqual(again, { woken: [], refused: [] });
    // Stopping a resting Instance only ends its rest.
    await sql(`UPDATE data.agent_reborn_intents SET state='failed' WHERE intent_id=$1`, [wakeIntent.intent_id]);
    const stoppedRest = await new PostgresRuntimeRepository(database).stopRestingInstances({ requestId: "rest-stop",
      channelId: "channel", actorUserId: "caller", mention: `CODEX:${(await sql(`SELECT channel_instance_id FROM data.instances
        WHERE instance_id=$1`, [sleeper.instanceId])).rows[0].channel_instance_id}` }).catch(error => error);
    assert.deepEqual(stoppedRest.stopped?.map(item => item.instanceId), [sleeper.instanceId],
      String(stoppedRest.message ?? JSON.stringify(stoppedRest)));
    assert.equal((await sql(`SELECT rest_state FROM data.instances WHERE instance_id=$1`, [sleeper.instanceId])).rows[0]
      .rest_state, "stopped");
    assert.deepEqual((await reborn.wakeResting({ commandId: "wake-stopped", channelId: "channel",
      sourceMessageId: "connector-repository" })).woken, [], "a stopped Instance does not wake");

  } finally { await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await setup.end(); }
});

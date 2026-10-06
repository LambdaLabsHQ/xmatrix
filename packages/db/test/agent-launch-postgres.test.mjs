import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connectionString, integration } from "./postgres-database.fixture.mjs";

import { Client } from "pg";
import { digestCanonicalCloneCborV1, } from "@xmatrix/protocol";
import { convergeRuntimeAccess } from "../scripts/migrate.mjs";
import {
  createAuthorityDatabase,
  createAuthorityDatabaseRouter,
  PostgresMachineControlRepository,
  PostgresMessageRepository,
  PostgresRuntimeRepository,
} from "../dist/index.js";

const at = "2026-09-04T00:00:00.000Z";

integration("quota probe machine lease round trip rejects stale epochs and substituted results", async () => {
  await seed();
  const session = createAuthorityDatabase({ connectionString, shardId: "shard-0" }).openSession();
  try {
    const controls = new PostgresMachineControlRepository(session);
    const machine = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "probe-machine",
      hostId: "probe-host", daemonId: "probe-daemon" };
    const principal = { kind: "machine", id: "machine-daemon:owner:probe-machine:probe-host",
      ownerUserId: "owner", machineId: "probe-machine", hostId: "probe-host" };
    const connect = capabilities => controls.command({ ...machine, commandId: randomUUID(), action: "connect",
      principal, capabilities, payload: {}, metadata: {} });
    const target = { profileId: "profile-a", configurationDigest: "a".repeat(64) };
    const probe = { requestId: "probe-control", connectionEpoch: 1, targets: [target] };
    const issue = () => controls.command({ ...machine, commandId: randomUUID(), action: "issue",
      principal: { kind: "user", id: "owner" }, controlId: probe.requestId, commandType: "quota_probe",
      payload: { type: "machine_quota_probe", requestId: probe.requestId, probe } });
    await connect([]);
    await assert.rejects(issue(), error => error.code === "invalid_quota_probe");
    const connected = await connect(["machine_quota_probe_v2"]);
    probe.connectionEpoch = connected.connectionEpoch;
    await issue();
    const claimed = await controls.command({ ...machine, commandId: randomUUID(), action: "claim",
      principal, connectionEpoch: probe.connectionEpoch, commandTypes: ["quota_probe"], payload: {} });
    assert.equal(claimed.commands.length, 1);
    const result = { type: "machine_quota_probe_result", requestId: probe.requestId, probe: {
      requestId: probe.requestId, connectionEpoch: probe.connectionEpoch,
      results: [{ ...target, status: "observed", quotaSource: "provider_api",
        quotaObservedAt: new Date(Date.now() - 1000).toISOString(), quotaUsages: [{ percent: 100 }] }],
    } };
    const complete = payload => controls.command({ ...machine, commandId: randomUUID(), action: "complete",
      principal, connectionEpoch: probe.connectionEpoch, controlId: probe.requestId,
      eventType: "machine_quota_probe_result", relayLease: claimed.commands[0].payload.relayLease, payload });
    await assert.rejects(complete({ ...result, probe: { ...result.probe,
      results: [{ ...result.probe.results[0], profileId: "other" }] } }),
    error => error.code === "machine_command_result_mismatch");
    await complete(result);
    const status = await controls.status({ requestId: randomUUID(), ownerUserId: "owner",
      machineId: machine.machineId, hostId: machine.hostId, controlId: probe.requestId,
      commandType: "quota_probe", expected: { requestId: probe.requestId } });
    assert.equal(status.status, "completed");
    assert.deepEqual(status.result.probe, result.probe);
    await connect(["machine_quota_probe_v2"]);
    probe.requestId = "probe-stale";
    await assert.rejects(issue(), error => error.code === "invalid_quota_probe");
  } finally { await session.close(); }
});

integration("runtime grant migration repairs existing relations and protects future ones", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required for runtime grant tests");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DO $test$
      DECLARE runtime_role TEXT := current_database() || '_runtime';
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
          EXECUTE format('CREATE ROLE %I NOLOGIN',runtime_role);
        END IF;
      END
      $test$`);
    const migration = await readFile(
      new URL("../migrations/0039_expand_runtime_relation_grants.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    const runtimeRole = (await client.query(
      "SELECT current_database() || '_runtime' AS runtime_role",
    )).rows[0].runtime_role;
    const denied = await client.query(`SELECT namespace.nspname,class.relname
      FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname IN ('control','data') AND class.relkind IN ('r','p')
        AND class.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        AND NOT has_table_privilege($1,class.oid,'SELECT,INSERT,UPDATE,DELETE')`, [runtimeRole]);
    assert.deepEqual(denied.rows, []);

    await client.query("CREATE TABLE data.runtime_grant_future_probe (id TEXT)");
    const future = await client.query(
      "SELECT has_table_privilege($1,'data.runtime_grant_future_probe','SELECT,INSERT,UPDATE,DELETE') AS allowed",
      [runtimeRole],
    );
    assert.equal(future.rows[0].allowed, true);
    await client.query("DROP TABLE data.runtime_grant_future_probe");
  } finally {
    await client.end();
  }
});

integration("migration executor atomically converges an explicit runtime role", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required for runtime grant tests");
  const client = new Client({ connectionString });
  await client.connect();
  const runtimeRole = "xmatrix_migration_contract_runtime";
  try {
    await client.query(`DO $test$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='xmatrix_migration_contract_runtime') THEN
          CREATE ROLE xmatrix_migration_contract_runtime NOLOGIN;
        END IF;
      END
      $test$`);
    await client.query("BEGIN");
    const snapshot = await convergeRuntimeAccess(client, runtimeRole);
    await client.query("COMMIT");
    assert.equal(snapshot.runtimeRole, runtimeRole);
    assert.equal(snapshot.schemas, 2);
    assert.ok(snapshot.tables > 0);
    assert.ok(snapshot.sequences > 0);

    await client.query("CREATE TABLE data.runtime_access_future_table_probe (id TEXT)");
    await client.query("CREATE SEQUENCE data.runtime_access_future_sequence_probe");
    const future = await client.query(`SELECT
      has_table_privilege($1,'data.runtime_access_future_table_probe',
        'SELECT,INSERT,UPDATE,DELETE') AS table_allowed,
      has_sequence_privilege($1,'data.runtime_access_future_sequence_probe',
        'USAGE,SELECT') AS sequence_allowed`, [runtimeRole]);
    assert.equal(future.rows[0].table_allowed, true);
    assert.equal(future.rows[0].sequence_allowed, true);
    await client.query("DROP TABLE data.runtime_access_future_table_probe");
    await client.query("DROP SEQUENCE data.runtime_access_future_sequence_probe");

    await client.query("BEGIN");
    await client.query("CREATE TABLE data.runtime_access_rollback_probe (id TEXT)");
    await assert.rejects(
      convergeRuntimeAccess(client, "xmatrix_missing_runtime_role"),
      /runtime role does not exist/u,
    );
    await client.query("ROLLBACK");
    const rollbackProbe = await client.query(
      "SELECT to_regclass('data.runtime_access_rollback_probe') AS relation",
    );
    assert.equal(rollbackProbe.rows[0].relation, null);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

async function seed(shardId = "shard-0") {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required for Agent Launch tests");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`TRUNCATE data.agent_reborn_intents,data.idempotency_keys,data.message_attachment_refs,data.message_mutations,data.messages,data.message_attention,data.message_attention_revisions,
      data.agent_message_executions,data.channel_message_sequences,data.message_sequence_reservations,
      data.machine_run_snapshot_heads,data.machine_daemon_commands,
      data.machine_daemons,data.agent_launches,data.instances,data.runs,data.natural_key_counters,data.natural_key_reservations,data.channel_access,data.outbox,
      data.workspaces,data.channels,data.space_control_heads,data.space_members,
      data.spaces,control.channel_space_routes,control.channel_space_directory,
      control.entity_space_routes,control.space_placement,control.postgres_shards,
      control.scoped_control_command_replays,control.registration_quota_observations CASCADE`);
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at) VALUES
      ('shard-0','active','test',$1,$1),('shard-1','active','test',$1,$1)`, [at]);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ('space-launch',$2,1,'active',NULL,'test',$1,$1)`, [at, shardId]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ('space-launch','owner','Launch test','space-launch-rank',1,'{}',$1,$1)`, [at]);
    await client.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ('space-launch','owner','owner',1,'owner@example.test','Owner',$1,$1)`, [at]);
    await client.query(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at)
      VALUES ('space-launch',1,$1)`, [at]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,
       version,metadata_json,created_at,updated_at,activity_at)
      VALUES ('channel-launch','space-launch','Launch','launch','open','channel-launch-rank',
        1,'{}',$1,$1,$1)`, [at]);
    await client.query(`INSERT INTO control.channel_space_routes
      (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
      VALUES ('channel-launch','space-launch',$2,1,1,'active',$1)`, [at, shardId]);
    await client.query(`INSERT INTO data.workspaces
      (workspace_id,owner_user_id,machine_id,canonical_cwd,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      VALUES ('workspace-launch','owner','machine-1','/srv/xmatrix','workspace-rank',1,
        '{"hostId":"host-1","displayName":"xmatrix"}',$1,$1)`, [at]);
  } finally {
    await client.end();
  }
}

async function repository(shardId = "shard-0", observer) {
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    connectTimeoutMs: 60_000, statementTimeoutMs: 10_000, transactionTimeoutMs: 20_000,
    lockTimeoutMs: 2_000, observer });
  const routed = shardId === "shard-0" ? database : createAuthorityDatabaseRouter({
    directory: database,
    shards: { "shard-0": database, "shard-1": createAuthorityDatabase({ connectionString,
      shardId: "shard-1", connectTimeoutMs: 60_000, statementTimeoutMs: 10_000,
      transactionTimeoutMs: 20_000, lockTimeoutMs: 2_000, observer }) },
  });
  const session = routed.openSession();
  return { repo: new PostgresRuntimeRepository(session, "shard-0"), session };
}

integration("message-id ACK preserves the summon boundary, scope and replay on PostgreSQL", async () => {
  await seed();
  const client = new Client({ connectionString });
  await client.connect();
  const { session } = await repository();
  const messages = new PostgresMessageRepository(session);
  const input = {
    requestId: "ack-live-request", commandId: "ack-live-command", requestDigest: "a".repeat(64),
    spaceId: "space-launch", channelId: "channel-launch",
    principal: { kind: "user", id: "owner" }, messageId: "ack-live-target",
  };
  try {
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence)
      SELECT 'space-launch',channel_id,message_id,sequence,1,'user','owner',
        'xmatrix.message.text','hash','inline','fixture',$1,$1,$1,message_id
      FROM (VALUES ('channel-launch','ack-live-target',4),
        ('channel-launch','ack-live-newer',9),('other-channel','ack-live-foreign',1))
        AS fixture(channel_id,message_id,sequence)`, [at]);
    const parked = await messages.acknowledge(input);
    assert.equal(parked.ackedSequence, 4);
    assert.equal(parked.committedSequence, 9);
    const replayed = await messages.acknowledge(input);
    assert.deepEqual(replayed, parked);
    await assert.rejects(messages.acknowledge({ ...input,
      commandId: "ack-live-foreign-command", messageId: "ack-live-foreign" }),
      (error) => error.code === "message_not_found");
    await assert.rejects(messages.acknowledge({ ...input,
      commandId: "ack-live-mismatch-command", sequence: 9 }),
      (error) => error.code === "invalid_command");
    const cursor = await client.query(`SELECT acknowledged_sequence FROM data.delivery_cursors
      WHERE space_id='space-launch' AND channel_id='channel-launch' AND subject_id='user:owner'`);
    assert.equal(Number(cursor.rows[0].acknowledged_sequence), 4);
    const latest = await messages.acknowledge({ ...input,
      commandId: "ack-live-latest-command", messageId: undefined });
    assert.equal(latest.ackedSequence, 9);
  } finally {
    await session.close();
    await client.query("DELETE FROM data.messages WHERE message_id LIKE 'ack-live-%'");
    await client.query("DELETE FROM data.idempotency_keys WHERE idempotency_key LIKE 'ack-live-%'");
    await client.query("DELETE FROM data.delivery_cursors WHERE space_id='space-launch' AND subject_id='user:owner'");
    await client.query("DELETE FROM data.message_attention_revisions WHERE space_id='space-launch' AND subject_id='user:owner'");
    await client.end();
  }
});

async function insertContinuationMessage(session, messageId) {
  await session.transaction({ requestId: `source-${messageId}`, operation: "test.continuation" }, tx => tx.query({
    name: "test_continuation_message", text: `INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,body_hash,payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence)
      VALUES ('space-launch','channel-launch',$1,$2,1,'user','owner','xmatrix.message.text',repeat('a',64),repeat('a',64),'inline','fixture',$3,$3,$3,$1)`,
    values: [messageId, Number(messageId.split("-").at(-1)) + 1, at], maxRows: 0 }));
}

integration("routing preflight outcomes are queryable without Runs and fence changed source messages", async () => {
  await seed();
  const { repo, session } = await repository();
  const sourceMessageId = 'preflight-source-0';
  const body = '@auto machine:missing inspect';
  const bodyHash = await digestCanonicalCloneCborV1(body);
  try {
    await insertContinuationMessage(session, sourceMessageId);
    await session.transaction({ requestId: 'preflight-source-hash', operation: 'test.preflight' }, tx => tx.query({
      name: 'preflight_source_hash', text: 'UPDATE data.messages SET body_hash=$1 WHERE message_id=$2', values: [bodyHash, sourceMessageId], maxRows: 0 }));
    const input = { channelId: 'channel-launch', sourceMessageId, actorUserId: 'owner',
      rejected: [{ sourceMention: '@auto machine:missing', code: 'routing_no_eligible', routingDecision: {
        source: 'deterministic', evaluatedAt: new Date().toISOString(), candidateCount: 1,
        rows: [{ profileId: 'profile-a', harness: 'codex', machineId: 'machine-a', activeRuns: 0,
          maxConcurrent: 1, selected: false, excluded: ['machine_mismatch'] }] } }] };
    const outcomes = await Promise.all([repo.recordRoutingRejections(input), repo.recordRoutingRejections(input)]);
    assert.equal(outcomes.filter(outcome => outcome.reused).length, 1);
    const query = { requestId: 'preflight-query', actorUserId: 'owner', channelId: 'channel-launch', sourceMessageIds: [sourceMessageId], pageSize: 1 };
    const view = await repo.queryAgentLaunches(query);
    assert.equal(view.launches.length, 0);
    assert.equal(view.rejections.length, 1);
    assert.equal(view.rejections[0].code, 'routing_no_eligible');
    assert.equal(view.rejections[0].routingDecision.rows[0].profileId, 'profile-a');
    assert.equal(view.nextCursor, null);
    await assert.rejects(repo.queryAgentLaunches({ ...query, actorUserId: 'intruder' }));
    await session.transaction({ requestId: 'preflight-source-edited', operation: 'test.preflight' }, tx => tx.query({
      name: 'preflight_source_edited', text: "UPDATE data.messages SET edited_at=clock_timestamp() WHERE message_id=$1", values: [sourceMessageId], maxRows: 0 }));
    assert.deepEqual((await repo.queryAgentLaunches(query)).rejections, []);
    await assert.rejects(repo.recordRoutingRejections(input), error => error.code === 'conflict');
  } finally { await session.close(); }
});

integration("daemon launch evidence that trails the Hub clock keeps Launch and Run clocks monotonic", async () => {
  await seed();
  const client = new Client({ connectionString });
  await client.connect();
  const { repo, session } = await repository();
  // XMATRIX-HUB-63: a daemon clock two seconds behind the Hub that created the rows.
  const daemonAt = new Date(Date.parse(at) - 2_000).toISOString();
  try {
    await client.query(`INSERT INTO data.runs
      (run_id,owner_user_id,channel_id,workspace_machine_id,workspace_canonical_cwd,
       status,version,metadata_json,created_at,updated_at)
      VALUES ('channel-launch:7#1','owner','channel-launch','machine-1','/srv/xmatrix','starting',1,'{}',$1,$1)`, [at]);
    await client.query(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ('channel-launch:7','channel-launch:7#1','channel-launch',7,'offline',1,$1,$1)`, [at]);
    await client.query(`INSERT INTO data.agent_launches
      (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,instance_id,
       execution_key,control_id,machine_id,hostname,state,spawn_payload_json,next_attempt_at,created_at,updated_at,prepared_at)
      VALUES ('launch-skew','space-launch','channel-launch','trigger-skew','registration','owner','channel-launch:7#1','channel-launch:7',
        'execution-skew','control-skew','machine-1','host-1','prepared','{}',$1,$1,$1,$1)`, [at]);
    const update = (state, extra = {}) => repo.updateAgentLaunch({ requestId: randomUUID(),
      launchId: "launch-skew", channelId: "channel-launch", state, at: daemonAt, ...extra });
    const admitted = await update("admitted");
    assert.equal(admitted.launch.state, "admitted");
    assert.equal(new Date(admitted.launch.admittedAt).toISOString(), daemonAt);
    await update("failed", { errorStage: "daemon_spawn", errorCode: "spawn_failed", retryable: false });
    const rows = await client.query(`SELECT launch.state,launch.updated_at AS launch_updated_at,
        launch.finished_at,run.status,run.updated_at AS run_updated_at
      FROM data.agent_launches launch JOIN data.runs run ON run.run_id=launch.run_id
      WHERE launch.launch_id='launch-skew'`);
    assert.equal(rows.rows[0].state, "failed");
    assert.equal(rows.rows[0].status, "failed");
    assert.equal(rows.rows[0].launch_updated_at.toISOString(), at);
    assert.equal(rows.rows[0].run_updated_at.toISOString(), at);
    assert.equal(rows.rows[0].finished_at.toISOString(), daemonAt);
  } finally {
    await session.close();
    await client.end();
  }
});

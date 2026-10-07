import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

import {
  createAuthorityDatabase,
  PostgresChannelCatalogRepository,
  PostgresSpaceControlRepository,
  PostgresMessageRepository,
} from "../dist/index.js";

const connectionString = process.env.XMATRIX_TEST_POSTGRES_URL;
const postgresRequired = process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true";
const integration = connectionString ? test : postgresRequired ? test : test.skip;
const now = "2026-09-01T00:00:00.000Z";

async function seed() {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required for PostgreSQL catalog tests");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`TRUNCATE
      data.space_agent_registration_access,data.channel_transfer_proposals,data.outbox,data.idempotency_keys,data.message_mutations,control.scoped_control_command_replays,
      control.channel_space_directory,control.channel_space_routes,control.entity_space_routes,
      control.user_space_memberships,control.user_space_membership_routes,data.space_billing_usage,
      data.message_attachments,data.message_attachment_refs,data.automations,data.trace_access_grants,
      data.app_source_relations,
      data.message_attention,data.messages,data.instances,data.runs,data.channel_access,
      data.user_space_channel_view_preferences,data.channels,data.space_control_heads,
      data.space_members,data.spaces,control.space_placement,control.postgres_shards CASCADE`);
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','test',$1,$1)`, [now]);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ('space-catalog','shard-0',1,'active',NULL,'test',$1,$1)`, [now]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ('space-catalog','owner','Catalog test','space-rank',1,'{}',$1,$1)`, [now]);
    await client.query(`INSERT INTO data.space_members
      (space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ('space-catalog','user-1','member',1,'user@example.test','User',$1,$1),
        ('space-catalog','owner','owner',1,'owner@example.test','Owner',$1,$1),
        ('space-catalog','admin','admin',1,'admin@example.test','Admin',$1,$1)`, [now]);
    await client.query(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at)
      VALUES ('space-catalog',77,$1)`, [now]);
    await client.query(`INSERT INTO data.user_space_channel_view_preferences
      (space_id,user_id,follow_up_review_schedule,pinned_channel_ids_json,
       version,created_at,updated_at)
      VALUES ('space-catalog','user-1','off','["root-40"]',1,$1,$1)`, [now]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,
       search_rank_sequence,version,metadata_json,created_at,updated_at,activity_at)
      SELECT 'root-'||LPAD(value::text,2,'0'),'space-catalog',
        'Root '||LPAD(value::text,2,'0'),'root-'||LPAD(value::text,2,'0'),'open',
        'channel-root-'||LPAD(value::text,2,'0'),1,'{}',$1,$1,
        $1::timestamptz + (value||' minutes')::interval
      FROM generate_series(0,54) value`, [now]);
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,
       search_rank_sequence,version,metadata_json,created_at,updated_at,activity_at)
      VALUES
      ('child','space-catalog','Child','child','open',
       'channel-child',1,'{}',$1,$1,$1::timestamptz + interval '2 hours'),
      ('grandchild','space-catalog','Grandchild','grandchild','open',
       'channel-grandchild',1,'{}',$1,$1,$1::timestamptz + interval '3 hours'),
      ('775b105d-ac07-4e2c-b966-d8bb09c702ed','space-catalog',
       'Route target','route-target','open','channel-route-target',1,'{}',$1,$1,
       $1::timestamptz + interval '1 hour'),
      ('archive','space-catalog','Archive','archive','open',
       'channel-archive',1,'{}',$1,$1,$1),
      ('closed-hidden','space-catalog','Closed hidden','closed-hidden','closed',
       'channel-closed-hidden',1,'{}',$1,$1,$1),
      ('closed-visible','space-catalog','Closed visible','closed-visible','closed',
       'channel-closed-visible',1,'{}',$1,$1,$1)`, [now]);
    await client.query(`INSERT INTO data.channel_access
      (space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
      VALUES ('space-catalog','closed-visible','user','user-1',1,$1,$1),
        ('space-catalog','closed-visible','agent','root-00:1',1,$1,$1)`, [now]);
    await client.query(`INSERT INTO data.runs
      (run_id,owner_user_id,channel_id,status,version,metadata_json,
       created_at,updated_at)
      VALUES
      ('root-00:1#1','owner','root-00','running',1,'{}',$1,$1),
      ('root-40:6#1','owner','root-40','running',1,
       '{"executionKey":"execution-6","machineId":"machine-1","hostId":"host-1"}',$1,$1),
      ('root-40:7#1','owner','root-40','running',1,
       '{"executionKey":"execution-7","machineId":"machine-1","hostId":"host-1"}',$1,$1),
      ('root-40:8#1','owner','root-40','completed',1,
       '{"executionKey":"execution-terminal-ghost","machineId":"machine-1","hostId":"host-1"}',$1,$1),
      ('root-40:9#1','owner','root-40','finished',1,
       '{"executionKey":"execution-offline"}',$1,$1)`, [now]);
    await client.query(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES
      ('root-00:1','root-00:1#1','root-00',1,'online',1,$1,$1),
      ('root-40:6','root-40:6#1','root-40',6,'online',1,$1,$1),
      ('root-40:7','root-40:7#1','root-40',7,'busy',1,$1,$1),
      ('root-40:8','root-40:8#1','root-40',8,'online',1,$1,$1),
      ('root-40:9','root-40:9#1','root-40',9,'offline',1,$1,$1)`, [now]);
    // Catalogs project registered Runs as their actual Instance principals.
    // The registration allocation foreign keys belong to launch tests.
    await client.query("SET session_replication_role = replica");
    try {
      await client.query(`INSERT INTO data.run_agent_registrations
        (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
         grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        SELECT run_id,'space-catalog',owner_user_id,'machine-1','claude',owner_user_id,
          'allocation-'||run_id,repeat('a',64),1,1,1,1,'{}' FROM data.runs`);
    } finally { await client.query("SET session_replication_role = origin"); }
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
       legacy_body,created_at)
      VALUES ('space-catalog','child','message-1',1,1,'user','owner','message','hash',
        'inline','inline', $1::timestamptz + interval '4 hours',
        $1::timestamptz + interval '4 hours','message-rank','hello',$1)`, [now]);
    await client.query(`INSERT INTO data.message_attention
      (space_id,subject_id,channel_id,message_id,kind,timeline_sequence,created_at)
      VALUES ('space-catalog','user:user-1','child','message-1','mention',1,
        $1::timestamptz + interval '4 hours')`, [now]);
    // Match the production message writer's atomic activity-index update.
    await client.query(`UPDATE data.channels SET activity_at=$1::timestamptz + interval '4 hours'
      WHERE channel_id='child' AND space_id='space-catalog'`, [now]);
  } finally {
    await client.end();
  }
}

integration("a conversation moves with its own work; other conversations keep theirs", async () => {
  await seed();
  const db = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  const repository = new PostgresSpaceControlRepository(db, "shard-0");
  const attachmentHash = "a".repeat(64);
  await repository.createSpace({ requestId: "move-target", commandId: "move-target",
    spaceId: "move-target", ownerUserId: "owner", name: "Private" });
  const client = new Client({ connectionString });
  await client.connect();
  const command = { requestId: "move-test", commandId: "move-test", kind: "channel_configure",
    channelId: "root-40", actorUserId: "owner", expectedVersion: 1,
    spaceId: "move-target", at: new Date().toISOString() };
  try {
    await client.query(`INSERT INTO control.channel_space_directory
      SELECT channel_id,space_id,updated_at FROM data.channels`);
    await client.query(`INSERT INTO data.message_attachments
      (space_id,attachment_id,message_id,channel_id,object_key,content_hash,encoded_bytes,
       mime_type,name,version,created_at,updated_at)
      VALUES ('space-catalog','move-attachment','message-1','child',$2,
        $3,4,'text/plain','note.txt',1,$1,$1)`, [now, `objects/${attachmentHash}`, attachmentHash]);
    await client.query(`INSERT INTO data.message_attachment_refs
      SELECT space_id,attachment_id,message_id,channel_id,owner_user_id,object_key,
        content_hash,encoded_bytes,mime_type,name,presentation_residual_json,version,created_at,updated_at
      FROM data.message_attachments WHERE attachment_id='move-attachment'`);
    await client.query(`INSERT INTO data.automations
      (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,created_at,updated_at)
      VALUES ('move-automation','owner','child',$1,true,1,'{}',$1,$1)`, [now]);
    await client.query(`INSERT INTO data.trace_access_grants
      (grant_id,owner_user_id,viewer_user_id,agent_id,channel_id,duration,status,version,requested_at)
      VALUES ('move-trace','owner','user-1','agent-1','root-40','channel','approved',1,$1)`, [now]);
    await client.query(`INSERT INTO data.app_source_relations
      (relation_id,connection_id,space_id,channel_id,source_kind,source_ref,features_json,version,
       created_by,created_at,updated_at)
      VALUES ('move-relation','connection-1','space-catalog','child','repository','o/r','{}',1,'owner',$1,$1)`, [now]);
    await assert.rejects(repository.mutateChannel(command), /require a proposal/);
    const drafted = await repository.createTransferProposal({ requestId: "draft", proposalId: "proposal-1",
      channelId: "root-40", targetSpaceId: "move-target", principal: { kind: "user", id: "owner" } });
    assert.equal(drafted.proposal.outbound, null);
    assert.equal(drafted.proposal.inbound, null);
    const ack = (role) => repository.acknowledgeTransferProposal({ requestId: `ack-${role}`,
      sourceSpaceId: "space-catalog", proposalId: "proposal-1", role, principal: { kind: "user", id: "owner" } });
    await ack("outbound");
    assert.equal((await client.query("SELECT space_id FROM data.channels WHERE channel_id='root-40'")).rows[0].space_id, "space-catalog");
    // The move stops only live work it can account for; a live Instance
    // without its Run still blocks, and the failed move stops nothing.
    await client.query("UPDATE data.instances SET run_id='root-40:8#9' WHERE instance_id='root-40:8'");
    await assert.rejects(ack("inbound"), /resolve live instance before moving/u);
    assert.equal((await client.query("SELECT space_id FROM data.channels WHERE channel_id='child'")).rows[0].space_id,
      "space-catalog", "a failed move changes no Space");
    assert.deepEqual((await client.query(`SELECT status FROM data.runs
      WHERE run_id IN ('root-40:6#1','root-40:7#1') ORDER BY run_id`)).rows.map((row) => row.status),
    ["running", "running"], "failed move keeps live Runs running");
    await client.query("UPDATE data.instances SET run_id='root-40:8#1' WHERE instance_id='root-40:8'");
    const moved = await ack("inbound");
    assert.equal(moved.proposal.status, "completed");
    assert.deepEqual(moved.stopTargets.map((target) => target.runId).sort(),
      ["root-40:6#1", "root-40:7#1", "root-40:8#1"]);
    assert.deepEqual((await client.query(`SELECT run_id,status FROM data.runs
      WHERE run_id IN ('root-40:6#1','root-40:7#1') ORDER BY run_id`)).rows,
    [{ run_id: "root-40:6#1", status: "stopped" }, { run_id: "root-40:7#1", status: "stopped" }]);
    assert.equal((await client.query(`SELECT count(*)::int AS live FROM data.instances
      WHERE channel_id='root-40' AND status<>'offline'`)).rows[0].live, 0);
    assert.equal((await client.query("SELECT status FROM data.trace_access_grants WHERE grant_id='move-trace'"))
      .rows[0].status, "expired");
    assert.equal(moved.proposal.tree.length, 1);
    assert.equal((await ack("outbound")).proposal.status, "completed");
    assert.deepEqual((await client.query(`SELECT channel_id FROM data.channels
      WHERE space_id='move-target' ORDER BY channel_id`)).rows, [{ channel_id: "root-40" }]);
    // Another conversation keeps its Space, its history and its work.
    assert.equal((await client.query("SELECT space_id FROM data.channels WHERE channel_id='child'")).rows[0].space_id,
      "space-catalog");
    for (const table of ["messages", "message_attachments", "message_attachment_refs"]) {
      const facts = (await client.query(`SELECT space_id FROM data.${table} WHERE channel_id='child'`)).rows;
      assert.deepEqual(facts, [{ space_id: "space-catalog" }], table);
    }
    assert.equal((await client.query("SELECT enabled FROM data.automations WHERE automation_id='move-automation'"))
      .rows[0].enabled, true, "an Automation of a conversation that did not move keeps running");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM data.app_source_relations WHERE relation_id='move-relation'"))
      .rows[0].n, 1);
  } finally {
    await client.end();
  }
});

integration("a private catalog page reads member presentation without per-Channel queries", async () => {
  await seed();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      SELECT 'batch-'||LPAD(value::text,3,'0'),'space-catalog',
        'Batch '||value,'batch-'||LPAD(value::text,3,'0'),'closed',
        'batch-rank-'||value,1,'{}',$1,$1
      FROM generate_series(0,229) value`, [now]);
    await client.query(`INSERT INTO data.channel_access
      (space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
      VALUES ('space-catalog','batch-000','user','user-1',1,$1,$1)`, [now]);
  } finally {
    await client.end();
  }
  const queries = [];
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    observer: (observation) => {
      if (observation.operation === "channel.list" &&
          !observation.queryName.startsWith("database_phase_")) queries.push(observation.queryName);
    } });
  const spaces = new PostgresSpaceControlRepository(database, "shard-0");
  const page = await spaces.listChannels({ requestId: "private-page", spaceId: "space-catalog",
    principal: { kind: "user", id: "owner" }, limit: 200 });
  assert.equal(page.channels.length, 200);
  assert.equal(page.cursor, "batch-197");
  const byId = new Map(page.channels.map((channel) => [channel.id, channel]));
  assert.deepEqual(byId.get("batch-000").visibleHumanMemberIds,
    ["user:admin", "user:owner", "user:user-1"]);
  assert.deepEqual(byId.get("batch-001").visibleHumanMemberIds, ["user:admin", "user:owner"]);
  assert.ok(queries.length <= 6, `a catalog page made ${queries.length} SQL round trips`);
  assert.equal(queries.filter((name) => name === "closed_channel_visible_members_v1").length, 0);
  const inaccessible = await spaces.listChannels({ requestId: "private-not-granted", spaceId: "space-catalog",
    principal: { kind: "user", id: "user-1" }, familyOfChannelId: "batch-001" });
  assert.deepEqual(inaccessible.channels, []);
});

integration("a family list reads one Channel and the readable threads opened on it", async (t) => {
  await seed();
  const client = new Client({ connectionString });
  await client.connect();
  const thread = (root) => JSON.stringify({ kind: "thread", threadRootChannelId: root, threadRootMessageId: "m" });
  try {
    // root-00 has threads: open ones, one user-1 was granted, and one user-1
    // cannot read; `child` has threads of its own.
    await client.query(`UPDATE data.channels SET metadata_json=$1::jsonb
      WHERE channel_id IN ('child','closed-hidden','closed-visible')`, [thread("root-00")]);
    await client.query(`UPDATE data.channels SET metadata_json=$1::jsonb
      WHERE channel_id IN ('grandchild','775b105d-ac07-4e2c-b966-d8bb09c702ed')`, [thread("child")]);
  } finally {
    await client.end();
  }
  const { spaces } = catalogSpaceControl();
  const read = (principal, familyOfChannelId) => spaces.listChannels({
    requestId: "family-list", spaceId: "space-catalog", principal, limit: 200,
    ...(familyOfChannelId ? { familyOfChannelId } : {}),
  });
  const ids = (listed) => listed.channels.map((channel) => channel.id);
  const user = { kind: "user", id: "user-1" };
  const family = await read(user, "root-00");
  // Grandchildren, siblings and a closed child without a grant never appear.
  assert.deepEqual(ids(family), ["child", "closed-visible", "root-00"]);
  assert.equal(family.cursor, null);
  assert.deepEqual(ids(await read({ kind: "user", id: "owner" }, "root-00")),
    ["child", "closed-hidden", "closed-visible", "root-00"]);
  assert.deepEqual(ids(await read({ kind: "agent", id: "root-00:1" }, "root-00")),
    ["child", "closed-visible", "root-00"]);
  assert.deepEqual(ids(await read(user, "child")),
    ["775b105d-ac07-4e2c-b966-d8bb09c702ed", "child", "grandchild"]);
  // A Channel the principal cannot read yields no row for itself.
  assert.deepEqual(ids(await read(user, "closed-hidden")), []);
  const full = await read(user);
  // The catalog carries each Channel's message head and newest activity; a
  // message append never touches the durable updated_at column.
  const byId = new Map(full.channels.map((channel) => [channel.id, channel]));
  assert.equal(byId.get("child").messageCount, 1);
  assert.equal(byId.get("child").historyHeadSequence, 1);
  assert.equal(byId.get("child").updatedAt, "2026-09-01T04:00:00.000Z");
  assert.equal(byId.get("root-00").messageCount, 0);
  assert.equal(byId.get("root-00").updatedAt, now);
  const fullBytes = JSON.stringify(full).length;
  const familyBytes = JSON.stringify(family).length;
  t.diagnostic(`family list ${familyBytes} bytes vs full catalog ${fullBytes} bytes (${full.channels.length} rows)`);
  assert.ok(full.channels.length > family.channels.length);
  assert.ok(familyBytes < fullBytes);
});

integration("channel catalog pages and resolves against PostgreSQL", async () => {
  await seed();
  const database = createAuthorityDatabase({
    connectionString,
    shardId: "shard-0",
    connectTimeoutMs: 60_000,
    statementTimeoutMs: 10_000,
    transactionTimeoutMs: 20_000,
  });
  const catalogSession = database.openSession();
  const repository = new PostgresChannelCatalogRepository(catalogSession, true);
  const base = {
    spaceId: "space-catalog",
    principal: { kind: "user", id: "user-1" },
    filter: "all",
  };

  const first = await repository.page({ ...base, requestId: "flat-1", view: "flat", limit: 50 });
  assert.equal(first.rows.length, 50);
  assert.deepEqual(first.rows.slice(0, 5).map((row) => row.channel.id), [
    "root-40", "child", "grandchild", "775b105d-ac07-4e2c-b966-d8bb09c702ed", "root-54",
  ], "pins lead, then every readable conversation by its own activity, wherever it sits");
  // Message appends advance activity_at, not updated_at. Chat-list clients sort
  // by the serialized updatedAt, so it must carry the newest message's time or a
  // busy Channel ranks by its last config write and disappears down the list.
  assert.equal(first.rows[1].channel.updatedAt, "2026-09-01T04:00:00.000Z");
  // The row carries its newest message, so a list can preview it without a
  // live push; a quiet conversation otherwise reads "No messages yet".
  assert.deepEqual(first.rows[1].channel.headMessage, {
    messageId: "message-1", sequence: 1, authorKind: "user", authorId: "owner",
    sentAt: "2026-09-01T04:00:00.000Z", recalledAt: null,
    preview: null, payloadBundleBase64: null, legacyBody: "hello",
  });
  assert.equal(first.rows[0].channel.headMessage, undefined, "no message, no head");
  // A head with a stored preview returns it instead of its payload.
  const seedClient = new Client({ connectionString });
  await seedClient.connect();
  try {
    await seedClient.query(`UPDATE data.messages SET payload_bundle_base64='AA',
      preview_json='{"bodyPreview":"hello","senderSnapshot":{"label":"Owner"}}' WHERE message_id='message-1'`);
  } finally { await seedClient.end(); }
  const previewed = await repository.page({ ...base, requestId: "flat-preview", view: "flat", limit: 50 });
  const previewedHead = previewed.rows.find((row) => row.channel.id === "child").channel.headMessage;
  assert.deepEqual(previewedHead.preview, { bodyPreview: "hello", senderSnapshot: { label: "Owner" } });
  assert.equal(previewedHead.payloadBundleBase64, null, "the payload stays in PostgreSQL");
  assert.equal(previewedHead.legacyBody, null);
  assert.deepEqual(
    catalogInstances(first.rows[0].channel).map((instance) => ({
      id: instance.id, channelInstanceId: instance.channelInstanceId,
    })),
    [
      { id: "root-40:6", channelInstanceId: "6" },
      { id: "root-40:7", channelInstanceId: "7" },
    ],
  );
  assert.equal(first.counts.active, 60, "every readable conversation is listed");
  assert.equal(first.catalogRevision, 77);
  assert.ok(first.nextCursor);

  const second = await repository.page({
    ...base, requestId: "flat-2", view: "flat", limit: 50, cursor: first.nextCursor,
  });
  const listed = [...first.rows, ...second.rows].map((row) => row.channel.id);
  assert.equal(new Set(listed).size, 60);
  assert.deepEqual(listed.slice(-3), ["archive", "closed-visible", "root-00"]);
  assert.equal(listed.includes("closed-hidden"), false);

  const unread = await repository.page({
    ...base, requestId: "unread", view: "flat", filter: "unread",
  });
  assert.deepEqual(unread.rows.map((row) => row.channel.id), ["child"]);

  const search = await repository.page({
    ...base, requestId: "search", view: "search", query: "root 4",
  });
  assert.ok(search.rows.length > 0);
  assert.ok(search.rows.every((row) => row.channel.name.toLowerCase().includes("root 4")));

  const resolved = await repository.resolve({
    requestId: "resolve",
    spaceId: base.spaceId,
    principal: base.principal,
    channelIds: ["root-40", "grandchild", "closed-hidden", "closed-visible"],
  });
  assert.deepEqual(resolved.pathsByChannelId.grandchild, ["grandchild"]);
  assert.equal(
    catalogInstances(resolved.channels.find((channel) => channel.id === "root-40")).length,
    2,
  );
  assert.equal(resolved.pathsByChannelId["closed-hidden"], undefined);
  assert.deepEqual(resolved.pathsByChannelId["closed-visible"], ["closed-visible"]);
  const routeResolved = await repository.resolve({
    requestId: "route-resolve",
    spaceId: base.spaceId,
    principal: base.principal,
    channelIds: [],
    routeToken: "c72dq68erek",
  });
  assert.deepEqual(routeResolved.pathsByRouteToken.c72dq68erek, ["775b105d-ac07-4e2c-b966-d8bb09c702ed"]);

  const ownerPage = await repository.page({
    ...base, requestId: "owner", view: "search", query: "closed hidden",
    principal: { kind: "user", id: "owner" },
  });
  assert.equal(ownerPage.rows.some((row) => row.channel.id === "closed-hidden"), true);
  const adminResolved = await repository.resolve({
    requestId: "admin-resolve", spaceId: base.spaceId,
    principal: { kind: "user", id: "admin" },
    channelIds: ["closed-hidden", "direct"],
  });
  assert.deepEqual(adminResolved.pathsByChannelId["closed-hidden"], ["closed-hidden"]);
  assert.equal(adminResolved.pathsByChannelId.direct, undefined);
  const agentPage = await repository.page({
    ...base, requestId: "agent-page", view: "search", query: "closed visible",
    principal: { kind: "agent", id: "root-00:1" },
  });
  assert.equal(agentPage.rows.some((row) => row.channel.id === "closed-visible"), true);
  assert.equal(agentPage.rows.some((row) => row.channel.id === "closed-hidden"), false);
  const agentResolved = await repository.resolve({
    requestId: "agent-resolve", spaceId: base.spaceId,
    principal: { kind: "agent", id: "root-00:1" },
    channelIds: ["closed-visible", "closed-hidden"],
  });
  assert.deepEqual(agentResolved.pathsByChannelId["closed-visible"], ["closed-visible"]);
  assert.equal(agentResolved.pathsByChannelId["closed-hidden"], undefined);
  const deferredPage = await repository.page({
    ...base, requestId: "flat-deferred-counts", view: "flat", includeCounts: false,
  });
  assert.equal(deferredPage.counts, null);
  assert.equal(deferredPage.rows.length, 50);
  const countsOnly = await repository.page({
    ...base, requestId: "counts-only", view: "flat", countsOnly: true,
  });
  assert.equal(countsOnly.rows.length, 0);
  assert.equal(countsOnly.nextCursor, null);
  assert.equal(countsOnly.counts.active, 60);
  await catalogSession.close();

  const directSessionA = database.openSession();
  const directSessionB = database.openSession();
  await directSessionA.health({ requestId: "direct-prewarm-a", operation: "test.prewarm" });
  await directSessionB.health({ requestId: "direct-prewarm-b", operation: "test.prewarm" });
  const directRepositories = [
    new PostgresSpaceControlRepository(directSessionA, "shard-0"),
    new PostgresSpaceControlRepository(directSessionB, "shard-0"),
  ];
  const newConversations = ["a", "b"].map((suffix) => ({
    requestId: `fast-create-${suffix}`, commandId: `fast-create-${suffix}`,
    channelId: `fast-create-${suffix}`, spaceId: base.spaceId,
    name: "New conversation", mode: "open", principal: base.principal,
  }));
  const createdConversations = await Promise.all(newConversations.map((input, index) =>
    directRepositories[index].createChannel(input)));
  assert.equal(new Set(createdConversations.map((channel) => channel.searchRankSeq)).size, 2);
  for (const [index, created] of createdConversations.entries()) {
    assert.match(created.searchRankSeq, /^pg:\d{20}$/u);
    const replay = await directRepositories[index].createChannel(newConversations[index]);
    assert.deepEqual(replay, created);
    const read = await directRepositories[index].getChannel({
      requestId: `fast-read-${index}`, spaceId: base.spaceId,
      channelId: created.id, principal: base.principal,
    });
    assert.equal(read.channel.id, created.id);
    await assert.rejects(directRepositories[index].createChannel({
      ...newConversations[index], commandId: `conflicting-create-${index}`,
    }), (error) => error.code === "channel_exists");
  }
  // Direct conversations are retired: creating one is refused.
  await directSessionB.close();
  await assert.rejects(directRepositories[0].createChannel({
    requestId: "direct-retired", commandId: "direct-retired", channelId: "direct-retired",
    spaceId: base.spaceId, name: "Retired DM", mode: "closed", principal: base.principal,
    metadata: {
      kind: "direct", participantKey: "user:owner\nuser:user-1",
      participants: [{ kind: "user", id: "owner" }, { kind: "user", id: "user-1" }],
    },
  }), (error) => error.code === "direct_conversation_retired");
  const spaces = directRepositories[0];
  const listedChannels = await spaces.listChannels({
    requestId: "presence-list", spaceId: base.spaceId, principal: base.principal, limit: 200,
  });
  assert.equal(
    catalogInstances(listedChannels.channels.find((channel) => channel.id === "root-40")).length,
    2,
  );
  const selectedChannel = await spaces.getChannel({
    requestId: "presence-get", spaceId: base.spaceId,
    channelId: "root-40", principal: base.principal,
  });
  assert.deepEqual(
    catalogInstances(selectedChannel.channel)
      .map((instance) => instance.channelInstanceId),
    ["6", "7"],
  );

  await directSessionA.close();
});

async function transferFixture(targetOwner = "owner") {
  await seed();
  const client = new Client({ connectionString }); await client.connect();
  await client.query(`INSERT INTO control.channel_space_directory
    SELECT channel_id,space_id,updated_at FROM data.channels`);
  const db = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  const repo = new PostgresSpaceControlRepository(db, "shard-0");
  await repo.createSpace({ requestId: "transfer-target", commandId: "transfer-target",
    spaceId: "transfer-target", ownerUserId: targetOwner, name: "Target Private" });
  return { client, repo,
    propose: (id = "proposal", principal = { kind: "user", id: "owner" }) => repo.createTransferProposal({
      requestId: `draft-${id}`, proposalId: id, channelId: "root-00", targetSpaceId: "transfer-target", principal }),
    ack: (role, userId = "owner", principalKind = "user", proposalId = "proposal") => repo.acknowledgeTransferProposal({
      requestId: crypto.randomUUID(), sourceSpaceId: "space-catalog", proposalId, role,
      principal: { kind: principalKind, id: userId } }),
  };
}

integration("Transfer requires two explicit roles even for one admin and concurrent retries move once", async () => {
  const f = await transferFixture();
  try {
    await f.propose();
    await f.ack("outbound"); await f.ack("outbound");
    assert.equal((await f.client.query("SELECT space_id FROM data.channels WHERE channel_id='root-00'")).rows[0].space_id, "space-catalog");
    const results = await Promise.all(Array.from({ length: 4 }, () => f.ack("inbound")));
    assert.ok(results.every((result) => result.proposal.status === "completed"));
    const row = (await f.client.query("SELECT space_id,version FROM data.channels WHERE channel_id='root-00'")).rows[0];
    assert.equal(row.space_id, "transfer-target"); assert.equal(Number(row.version), 2);
  } finally { await f.client.end(); }
});

integration("a proposal saved before the cutover with a target parent moves the conversation without one", async () => {
  const f = await transferFixture();
  try {
    await f.propose();
    // Proposals from before the cutover could name a parent in the target Space.
    await f.client.query(`UPDATE data.channel_transfer_proposals
      SET target_parent_id='old-parent',
        snapshot_json=jsonb_set(snapshot_json,'{targetParent}','[{"channel_id":"old-parent"}]'::jsonb)
      WHERE proposal_id='proposal'`);
    await f.ack("outbound");
    assert.equal((await f.ack("inbound")).proposal.status, "completed");
    assert.deepEqual((await f.client.query(
      "SELECT space_id FROM data.channels WHERE channel_id='root-00'")).rows,
    [{ space_id: "transfer-target" }]);
  } finally { await f.client.end(); }
});

integration("Source and target admins see one proposal and confirm only their own role", async () => {
  const f = await transferFixture("destination-owner");
  try {
    await f.propose();
    for (const [spaceId, userId] of [["space-catalog", "owner"], ["transfer-target", "destination-owner"]]) {
      const listed = await f.repo.listTransferProposals({ requestId: "list", spaceId, principal: { kind: "user", id: userId } });
      assert.equal(listed.proposals[0].id, "proposal");
      assert.ok(listed.proposals[0].lostUserIds.includes("owner"));
    }
    await assert.rejects(f.ack("inbound"), /requires its Space admin/);
    await assert.rejects(f.ack("outbound", "destination-owner"), /requires its Space admin/);
    await f.ack("inbound", "destination-owner");
    assert.equal((await f.ack("outbound")).proposal.status, "completed");
  } finally { await f.client.end(); }
});

integration("Agent drafts disclose no target membership and never acknowledge or discover queues", async () => {
  const f = await transferFixture();
  try {
    const draft = await f.propose("agent-draft", { kind: "agent", id: "root-00:1" });
    assert.equal(draft.proposal.targetName, undefined);
    assert.equal(draft.proposal.lostUserIds, undefined);
    assert.equal(draft.proposal.canAckInbound, undefined);
    await assert.rejects(f.ack("inbound", "root-00:1", "agent", "agent-draft"), /Only humans/);
    await assert.rejects(f.repo.listTransferProposals({ requestId: "agent-list", spaceId: "transfer-target",
      principal: { kind: "agent", id: "root-00:1" } }), /Only human admins/);
  } finally { await f.client.end(); }
});

integration("Channel, membership and expiration changes invalidate outstanding confirmations", async () => {
  const f = await transferFixture();
  try {
    await f.propose("tree"); await f.ack("outbound", "owner", "user", "tree");
    await f.client.query("UPDATE data.channels SET version=version+1 WHERE channel_id='root-00'");
    await assert.rejects(f.ack("inbound", "owner", "user", "tree"), /tree or access changed/);
    await f.propose("members"); await f.ack("outbound", "owner", "user", "members");
    await f.client.query("UPDATE data.space_members SET version=version+1 WHERE user_id='user-1'");
    await assert.rejects(f.ack("inbound", "owner", "user", "members"), /tree or access changed/);
    await f.propose("expired");
    await f.client.query("UPDATE data.channel_transfer_proposals SET expires_at=now()-interval '1 minute' WHERE proposal_id='expired'");
    await assert.rejects(f.ack("outbound", "owner", "user", "expired"), /expired/);
    assert.equal((await f.client.query("SELECT space_id FROM data.channels WHERE channel_id='root-00'")).rows[0].space_id, "space-catalog");
  } finally { await f.client.end(); }
});

integration("startup resolve omits participants, full reads hydrate them, and ACLs stay current", async () => {
  await seed();
  const observations = [];
  const db = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    observer: event => observations.push(event) });
  const catalog = new PostgresChannelCatalogRepository(db);
  const input = { requestId: "startup", spaceId: "space-catalog",
    principal: { kind: "user", id: "user-1" },
    channelIds: ["root-40", "closed-visible", "closed-hidden"] };
  const lean = await catalog.resolve({ ...input, includeParticipants: false });
  assert.deepEqual(lean.channels.map(channel => channel.id).sort(), ["closed-visible", "root-40"]);
  assert.deepEqual(lean.openChannelHumanMemberIdsBySpace, {});
  for (const channel of lean.channels) {
    assert.equal(Object.hasOwn(channel, "memberPresence"), false);
    assert.equal(Object.hasOwn(channel, "visibleHumanMemberIds"), false);
  }
  assert.equal(observations.some(event => event.queryName === "channel_agent_presence_v8"), false);
  assert.equal(observations.some(event => event.queryName === "channel_catalog_open_space_members_v2"), false);
  const full = await catalog.resolve(input);
  assert.equal(catalogInstances(full.channels.find(channel => channel.id === "root-40")).length, 2);
  assert.ok(full.channels.find(channel => channel.id === "closed-visible")
    .visibleHumanMemberIds.includes("user:user-1"));
  const spaces = new PostgresSpaceControlRepository(db, "shard-0");
  observations.length = 0;
  const detail = await spaces.getChannel({ ...input, channelId: "root-40" });
  assert.equal(observations.some(event => event.queryName === "channel_get_v4"), true);
  assert.equal(observations.some(event => event.queryName === "space_control_head_read_v1"), false);
  assert.equal(observations.some(event => event.queryName === "channel_list_member_v1"), false);
  assert.deepEqual(detail.channel.memberPresence,
    full.channels.find(channel => channel.id === "root-40").memberPresence);
  await assert.rejects(spaces.getChannel({ ...input, channelId: "closed-hidden" }),
    error => error.code === "channel_not_found");
  await assert.rejects(spaces.getChannel({ ...input, channelId: "direct",
    principal: { kind: "user", id: "admin" } }), error => error.code === "channel_not_found");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("DELETE FROM data.channel_access WHERE channel_id='closed-visible' AND subject_id='user-1'");
  } finally { await client.end(); }
  await assert.rejects(spaces.getChannel({ ...input, channelId: "closed-visible" }),
    error => error.code === "channel_not_found");
  const revoked = await catalog.resolve({ ...input, includeParticipants: false });
  assert.deepEqual(revoked.channels.map(channel => channel.id), ["root-40"]);
});

integration("a registered Instance reads its Space's catalog as the Instance it is authorized as", async () => {
  await seed();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // A registered Run is authorized as its Instance, which has no Profile row.
    // The binding's registration family is not under test, so its foreign keys
    // are not replayed here.
    await client.query("SET session_replication_role = replica");
    await client.query(`INSERT INTO data.runs
      (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ('root-01:1#1','owner','root-01','running',1,'{}',$1,$1),
        ('root-02:1#1','owner','root-02','running',1,'{}',$1,$1)`, [now]);
    await client.query(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ('root-01:1','root-01:1#1','root-01',1,'online',1,$1,$1),
        ('root-02:1','root-02:1#1','root-02',1,'online',1,$1,$1)`, [now]);
    await client.query(`INSERT INTO data.run_agent_registrations
      (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
       grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ('root-01:1#1','space-catalog','owner','machine-1','claude','owner','allocation-1',repeat('a',64),1,1,1,1,'{}'),
        ('root-02:1#1','other-space','owner','machine-1','claude','owner','allocation-2',repeat('b',64),1,1,1,1,'{}')`);
  } finally {
    await client.end();
  }
  const { database, spaces } = catalogSpaceControl();
  const catalogSession = database.openSession();
  const catalog = new PostgresChannelCatalogRepository(catalogSession, true);
  const registered = { kind: "agent", id: "root-01:1" };
  const elsewhere = { kind: "agent", id: "root-02:1" };

  assert.equal((await spaces.getSpace({ requestId: "instance-space", spaceId: "space-catalog",
    principal: registered })).id, "space-catalog");
  const listed = (await spaces.listChannels({ requestId: "instance-list", spaceId: "space-catalog",
    principal: registered, limit: 200 })).channels.map((channel) => channel.id);
  // Open Channels are readable; a closed Channel the Instance holds no grant for is not.
  assert.ok(listed.includes("root-01"));
  assert.ok(!listed.includes("closed-hidden"));
  const resolved = await catalog.resolve({ requestId: "instance-resolve", spaceId: "space-catalog",
    principal: registered, channelIds: ["root-01", "closed-hidden"] });
  assert.deepEqual(resolved.pathsByChannelId["root-01"], ["root-01"]);
  assert.equal(resolved.pathsByChannelId["closed-hidden"], undefined);

  // An Instance bound in another Space reads nothing here.
  await assert.rejects(spaces.getSpace({ requestId: "elsewhere-space", spaceId: "space-catalog",
    principal: elsewhere }), (error) => error.code === "space_not_found");
  await assert.rejects(spaces.listChannels({ requestId: "elsewhere-list", spaceId: "space-catalog",
    principal: elsewhere }), (error) => error.code === "channel_not_found");
  await catalogSession.close();
});

integration("xMatrix renames a conversation only while its name is automatic; a person's name stays", async () => {
  const { client, repository } = await seededSpaceControl();
  try {
    await client.query(`UPDATE data.channels SET metadata_json = metadata_json || '{"autoName":true}'::jsonb
      WHERE channel_id='child'`);
    const current = async () => (await client.query(
      "SELECT name, version, metadata_json FROM data.channels WHERE channel_id='child'")).rows[0];
    const rename = async (name, automaticName) => repository.mutateChannel({
      requestId: `rename-${name}`, commandId: `rename-${name}`, kind: "channel_configure", channelId: "child",
      actorUserId: "owner", expectedVersion: Number((await current()).version), at: new Date().toISOString(),
      name, ...(automaticName ? { automaticName: true } : {}) });

    await rename("Flaky login test", true);
    assert.equal((await current()).name, "Flaky login test");
    assert.equal((await current()).metadata_json.autoName, true, "an automatic name stays automatic");

    await rename("Login reliability", false);
    assert.equal((await current()).name, "Login reliability");
    assert.equal((await current()).metadata_json.autoName, undefined, "a person's rename makes the name theirs");
    await assert.rejects(rename("Something else", true), (error) => error.code === "channel_named_by_person");
    assert.equal((await current()).name, "Login reliability");
  } finally {
    await client.end();
  }
});

integration("a summary records the Run that wrote it, when, and the newest message it read in this Channel", async () => {
  const { client, repository } = await seededSpaceControl();
  try {
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
       legacy_body,created_at)
      VALUES ('space-catalog','root-01','elsewhere-1',9,1,'user','owner','message','hash',
        'inline','inline',$1,$1,'elsewhere-rank','elsewhere',$1)`, [now]);
    const current = async () => (await client.query(
      "SELECT version, metadata_json FROM data.channels WHERE channel_id='child'")).rows[0];
    let step = 0;
    const configure = async (fields) => repository.mutateChannel({
      requestId: `summary-${++step}`, commandId: `summary-${step}`, kind: "channel_configure", channelId: "child",
      actorUserId: "owner", expectedVersion: Number((await current()).version), at: now, ...fields });

    await prepareAboutInput(client, "child:about#1");
    await configure({ summary: "Fixing summaries", summaryAuthor: {
      runId: "child:about#1", agentName: "claude", throughMessageId: "message-1" } });
    assert.deepEqual((await current()).metadata_json.summarySource, {
      author: { kind: "run", runId: "child:about#1", agentName: "claude" }, generatedAt: now, throughSequence: 1,
    });
    const listed = await repository.getChannel({ requestId: "summary-read", spaceId: "space-catalog",
      channelId: "child", principal: { kind: "user", id: "owner" } });
    assert.equal(listed.channel.summarySource.throughSequence, 1);

    // Another Channel's message says nothing about how far this summary reads.
    await prepareAboutInput(client, "child:about#2");
    await assert.rejects(configure({ summary: "Fixing summaries again", summaryAuthor: {
      runId: "child:about#2", agentName: "codex", throughMessageId: "elsewhere-1" } }),
      error => error.code === "channel_about_input_mismatch");
    assert.equal((await current()).metadata_json.summary, "Fixing summaries");

    // A summary written without an author, or cleared, keeps no earlier source.
    await configure({ summary: "Unattributed" });
    assert.equal((await current()).metadata_json.summarySource, undefined);
    await prepareAboutInput(client, "child:about#3");
    await configure({ summary: "Attributed", summaryAuthor: {
      runId: "child:about#3", agentName: "claude", throughMessageId: "message-1" } });
    await configure({ summary: null });
    assert.equal((await current()).metadata_json.summarySource, undefined);
    assert.equal((await current()).metadata_json.summary, undefined);
  } finally {
    await client.end();
  }
});

async function seededSpaceControl() {
  await seed();
  const db = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  const repository = new PostgresSpaceControlRepository(db, "shard-0");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`INSERT INTO control.channel_space_directory
      SELECT channel_id,space_id,updated_at FROM data.channels`);
    return { client, repository };
  } catch (error) { await client.end(); throw error; }
}

function catalogSpaceControl() {
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  return { database, spaces: new PostgresSpaceControlRepository(database, "shard-0") };
}

function catalogInstances(channel) {
  const presence = channel.memberPresence;
  assert.deepEqual(Object.keys(presence), ["root-40:6", "root-40:7"]);
  return Object.values(presence).flatMap(member => member.instances);
}

async function prepareAboutInput(client, runId, channelId = "child", read = true) {
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,'owner',$2,'running',1,$3::jsonb,$4,$4)`, [runId,channelId,
    JSON.stringify({ routedAs: "management_channel_about", runtimeSessionId: runId,
      channelAboutTriggerRequestId: "bucket-1", ...(channelId === "child" ? { channelAboutTriggerMessageId: "message-1" } : {}) }),now]);
  await client.query("SET session_replication_role=replica");
  try {
    const limits = JSON.stringify({ workspaces: [], models: [], capabilities: [], maxConcurrent: 4 });
    await client.query(`INSERT INTO data.space_agent_registration_access
      (space_id,owner_user_id,machine_id,harness,grant_state,grant_revision,grant_execution_revision,grant_limits,
       policy_state,policy_revision,policy_execution_revision,policy_limits,updated_at)
      VALUES ('space-catalog','owner','machine-1','claude','active',1,1,$1::jsonb,'enabled',1,1,$1::jsonb,$2)
      ON CONFLICT DO NOTHING`, [limits,now]);
    await client.query(`INSERT INTO data.run_agent_registrations
      (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
       grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ($1,'space-catalog','owner','machine-1','claude','owner',$2,repeat('a',64),1,1,1,1,$3::jsonb)`, [runId,`allocation-${runId}`,JSON.stringify({ workspaces: [], models: [], capabilities: [] })]);
  } finally { await client.query("SET session_replication_role=origin"); }
  if (!read) return;
  const db = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  return new PostgresMessageRepository(db).history({ requestId: `input-${runId}`,spaceId: "space-catalog",
    channelId,principal: { kind: "agent",id: runId } });
}

integration("metadata revisions retain full content, reject stale writes, and restore by appending with replay", async () => {
  const { client, repository } = await seededSpaceControl();
  let command = 0;
  const mutate = fields => repository.mutateChannel({ requestId: `revision-${++command}`,commandId: `revision-${command}`,
    kind: "channel_configure", channelId: "child",actorUserId: "owner",at: now,...fields });
  const history = (selection = {}, principal = { kind: "user",id: "owner" }) => repository.metadataHistory({
    requestId: "history",spaceId: "space-catalog",channelId: "child",principal,...selection });
  try {
    await mutate({ name: "First",expectedRevision: 0 });
    await mutate({ name: "Second",expectedRevision: 1 });
    let result = await history();
    assert.deepEqual(result.revisions.map(row => [Number(row.revision),row.name]), [[2,"Second"],[1,"First"],[0,"Child"]]);
    assert.equal(result.revisions[2].source_json.provenanceKnown, false);
    assert.equal(result.revisions[0].source_json.actorUserId, "owner");
    assert.equal(result.hasMore, false);
    assert.equal((await history({ limit: 1 })).hasMore, true);
    assert.deepEqual((await history({ beforeRevision: 2 })).revisions.map(row => Number(row.revision)), [1,0]);
    await assert.rejects(mutate({ name: "Stale",expectedRevision: 0 }), error => error.code === "metadata_revision_conflict");
    assert.equal((await history()).revisions.length, 3);
    const restore = { requestId: "restore",commandId: "restore",kind: "channel_configure",channelId: "child",
      actorUserId: "owner",at: new Date().toISOString(),restoreRevision: 1,expectedRevision: 2 };
    const committed = await repository.mutateChannel(restore);
    assert.deepEqual(await repository.mutateChannel(restore), committed, "exact replay adds nothing");
    result = await history();
    assert.equal(result.currentRevision, 3);
    assert.equal(result.revisions[0].name, "First");
    assert.equal(Number(result.revisions[0].parent_revision), 2);
    assert.equal(result.revisions[0].source_json.restoredFromRevision, 1);
    assert.equal(result.revisions[1].name, "Second", "bad version retained");
    await assert.rejects(client.query(`UPDATE data.channel_metadata_revisions SET name='forged' WHERE channel_id='child'`),
      error => error.code === "23514");
    await assert.rejects(mutate({ restoreRevision: 99,expectedRevision: 3 }), error => error.code === "not_found");
    await assert.rejects(mutate({ restoreRevision: 1 }), error => error.code === "invalid_command");
    assert.equal((await history()).currentRevision, 3);
    // Force a failure after history insertion: transaction rollback preserves both old current and history.
    await client.query(`CREATE FUNCTION pg_temp.fail_metadata_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name='fail-after-history' THEN RAISE EXCEPTION 'forced failure after history' USING ERRCODE='P0001'; END IF;
      RETURN NEW; END; $$`);
    await client.query(`CREATE TRIGGER test_metadata_write_failure BEFORE UPDATE ON data.channels
      FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_metadata_write()`);
    try {
      await assert.rejects(mutate({ name: "fail-after-history",expectedRevision: 3 }), error => error.code === "P0001");
    } finally { await client.query("DROP TRIGGER test_metadata_write_failure ON data.channels"); }
    assert.equal((await history()).revisions.length, 4);
  } finally { await client.end(); }
});

integration("About history records exact input references and refuses foreign, stale and ended Runs", async () => {
  const { client, repository } = await seededSpaceControl();
  let command = 0;
  const mutate = fields => repository.mutateChannel({ requestId: `about-version-${++command}`,commandId: `about-version-${command}`,
    kind: "channel_configure",channelId: "child",actorUserId: "owner",at: now,...fields });
  const about = (runId,throughMessageId = "message-1") => ({ summary: "About generated",summaryAuthor: { runId,agentName: "claude",throughMessageId } });
  const history = () => repository.metadataHistory({ requestId: "history",spaceId: "space-catalog",channelId: "child",
    principal: { kind: "user",id: "owner" } });
  try {
    const page = await prepareAboutInput(client,"child:about#1");
    assert.equal(page.aboutInput.expectedRevision, 0);
    const input = await repository.metadataHistory({ requestId: "input",spaceId: "space-catalog",channelId: "child",
      principal: { kind: "user",id: "owner" },inputId: page.aboutInput.inputId });
    assert.deepEqual(input.input.references_json.map(ref => ref.messageId), page.messages.map(message => message.messageId));
    assert.equal(input.input.references_json[0].contentHash, "hash");
    await client.query(`UPDATE data.messages SET recalled_at=$1 WHERE message_id='message-1'`, [now]);
    const hiddenInput = await repository.metadataHistory({ requestId: "redacted-input",spaceId: "space-catalog",channelId: "child",
      principal: { kind: "user",id: "owner" },inputId: page.aboutInput.inputId });
    assert.equal(hiddenInput.input.references_json[0].contentUnavailable, true);
    assert.equal(hiddenInput.input.references_json[0].payloadRef, undefined);
    await client.query(`UPDATE data.messages SET recalled_at=NULL WHERE message_id='message-1'`);
    await assert.rejects(client.query(`UPDATE data.channel_about_inputs SET run_id='forged' WHERE input_id=$1`, [page.aboutInput.inputId]),
      error => error.code === "23514");
    await mutate({ ...about("child:about#1"),expectedRevision: 0 });
    const revision = (await history()).revisions[0];
    assert.deepEqual(revision.source_json.inputIds, [page.aboutInput.inputId]);
    assert.equal(revision.source_json.triggerMessageId, "message-1");
    assert.equal(revision.source_json.triggerRequestId, "bucket-1");
    await assert.rejects(mutate(about("child:about#1")), error => error.code === "metadata_revision_conflict");
    await prepareAboutInput(client,"root-01:about#1","root-01");
    await assert.rejects(mutate(about("root-01:about#1")), error => error.code === "channel_about_scope_invalid");
    await prepareAboutInput(client,"child:about#2","child",false);
    await assert.rejects(mutate(about("child:about#2")), error => error.code === "channel_about_input_required");
    await prepareAboutInput(client,"child:about#3");
    await client.query(`UPDATE data.runs SET status='completed' WHERE run_id='child:about#3'`);
    await assert.rejects(mutate(about("child:about#3")), error => error.code === "channel_about_scope_invalid");
    await prepareAboutInput(client,"child:about#4");
    await assert.rejects(mutate({ ...about("child:about#4"), mode: "closed" }), error => error.code === "channel_about_scope_invalid");
    await assert.rejects(mutate({ name: "Bypassed",actorRunId: "child:about#4" }), error => error.code === "channel_about_scope_invalid");
    await assert.rejects(mutate(about("child:about#4","missing")), error => error.code === "channel_about_input_mismatch");
    await client.query(`UPDATE data.space_agent_registration_access SET grant_state='revoked' WHERE space_id='space-catalog'`);
    await assert.rejects(mutate(about("child:about#4")), error => error.code === "registration_revoked");
    assert.equal((await history()).currentRevision, 1);
  } finally { await client.end(); }
});

integration("metadata history and input reads obey current Channel content permissions", async () => {
  const { client, repository } = await seededSpaceControl();
  const history = (channelId, principal, more = {}) => repository.metadataHistory({ requestId: "history-access",
    spaceId: "space-catalog",channelId,principal,...more });
  try {
    for (const channelId of ["closed-hidden","closed-visible"]) {
      await repository.mutateChannel({ requestId: `metadata-${channelId}`,commandId: `metadata-${channelId}`,
        kind: "channel_configure",channelId,actorUserId: "owner",at: now,name: "History" });
    }
    await assert.rejects(history("closed-hidden",{ kind: "user",id: "user-1" }), error => error.code === "channel_not_found");
    assert.equal((await history("closed-visible",{ kind: "user",id: "user-1" })).revisions.length, 2);
    await client.query(`DELETE FROM data.channel_access WHERE channel_id='closed-visible' AND subject_kind='user'`);
    await assert.rejects(history("closed-visible",{ kind: "user",id: "user-1" }), error => error.code === "channel_not_found");
    await assert.rejects(history("child",{ kind: "user",id: "outsider" }), error => error.code === "channel_not_found");
    const page = await prepareAboutInput(client,"child:about#1");
    assert.equal((await history("child",{ kind: "agent",id: "child:about#1" })).currentRevision, 0);
    assert.equal((await history("closed-visible",{ kind: "user",id: "owner" },{ inputId: page.aboutInput.inputId })).input, null);
    await assert.rejects(history("closed-hidden",{ kind: "agent",id: "child:about#1" }), error => error.code === "channel_not_found");
  } finally { await client.end(); }
});

integration("two writers of the same metadata revision commit exactly one new content version", async () => {
  const { client, repository } = await seededSpaceControl();
  try {
    const results = await Promise.allSettled(["A","B"].map(name => repository.mutateChannel({
      requestId: name,commandId: name,kind: "channel_configure",channelId: "child",actorUserId: "owner",at: now,
      name,expectedRevision: 0 })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const result = await repository.metadataHistory({ requestId: "history",spaceId: "space-catalog",channelId: "child",
      principal: { kind: "user",id: "owner" } });
    assert.equal(result.currentRevision, 1);
    assert.equal(result.revisions.length, 2);
  } finally { await client.end(); }
});

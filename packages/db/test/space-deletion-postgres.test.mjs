import { connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

import { Client } from "pg";

import {
  createAuthorityDatabase,
  PostgresSpaceControlRepository,
  SPACE_DELETION_RESTORE_WINDOW_MS,
  SPACE_PURGE_EXCLUDED_TABLES,
  SPACE_PURGE_STEPS,
} from "../dist/index.js";


const code = (expected) => (error) => error.code === expected;

async function fixture(client, repository, id) {
  const ids = {
    space: `${id}-space`, other: `${id}-other`, owner: `${id}-owner`, member: `${id}-member`,
    general: `${id}-general`, archived: `${id}-archived`, agent: `${id}-agent`,
    automation: `${id}-automation`, outsider: `${id}-outsider`,
  };
  ids.instance = `${ids.general}:1`;
  ids.run = `${ids.instance}#1`;
  const salt = id.replace(/[^0-9a-f]/gu, "").slice(0, 32).padEnd(32, "0");
  const sha = (char) => `${char.repeat(32)}${salt}`;
  const scope = `channel-user:${encodeURIComponent(ids.general)}:${encodeURIComponent(ids.owner)}`;
  const foreignScope = `channel-user:${encodeURIComponent(`${id}-foreign`)}:${encodeURIComponent(ids.owner)}`;
  ids.restrictedKey = `restricted/${encodeURIComponent(scope)}/objects/${sha("a")}`;
  ids.foreignKey = `restricted/${encodeURIComponent(foreignScope)}/objects/${sha("b")}`;
  ids.sharedKey = `objects/${sha("c")}`;
  await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
    VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
  for (const spaceId of [ids.space, ids.other]) {
    await repository.createSpace({ requestId: `create-${spaceId}`, commandId: `create-${spaceId}`,
      spaceId, ownerUserId: ids.owner, name: "Deletion test",
      metadata: { joinPolicy: "open" } });
  }
  await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
    VALUES ($1,$2,'member',1,now(),now())`, [ids.space, ids.member]);
  await client.query(`INSERT INTO control.user_space_memberships (user_id,space_id,role,membership_version,updated_at)
    VALUES ($1,$2,'member',1,now())`, [ids.member, ids.space]);
  for (const [channelId, spaceId] of [
    [ids.general, ids.space], [ids.archived, ids.space], [`${id}-kept`, ids.other],
  ]) {
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      VALUES ($1,$2,$1,$1,'open',$1,1,'{}',now(),now())`,
    [channelId, spaceId]);
    await client.query(`INSERT INTO control.channel_space_routes
      (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
      VALUES ($1,$2,'shard-0',1,1,'active',now())`, [channelId, spaceId]);
  }
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$3,'running',1,'{"machineId":"machine-1","hostId":"host-1"}',now(),now())`,
  [ids.run, ids.owner, ids.general]);
  await client.query(`INSERT INTO data.instances
    (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,'online',1,now(),now())`, [ids.instance, ids.run, ids.general]);
  await client.query(`INSERT INTO data.automations
    (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,created_at,updated_at)
    VALUES ($1,$2,$3,now(),true,1,'{}',now(),now())`, [ids.automation, ids.owner, ids.general]);
  for (let sequence = 1; sequence <= 1_200; sequence++) {
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
       legacy_body,created_at)
      VALUES ($1,$2,$3,$4,1,'user',$5,'message','hash','inline','inline',now(),now(),$3,'hello',now())`,
    [ids.space, ids.general, `${id}-message-${sequence}`, sequence, ids.owner]);
  }
  for (const [attachmentId, key, hash] of [
    ["restricted", ids.restrictedKey, sha("a")], ["foreign", ids.foreignKey, sha("b")],
    ["shared", ids.sharedKey, sha("c")],
  ]) {
    await client.query(`INSERT INTO data.message_attachments
      (space_id,attachment_id,message_id,channel_id,object_key,content_hash,encoded_bytes,
       mime_type,name,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,4,'text/plain','note.txt',1,now(),now())`,
    [ids.space, `${id}-${attachmentId}`, `${id}-message-1`, ids.general, key, hash]);
  }
  return ids;
}

async function remaining(client, spaceId, channelIds) {
  const counts = {};
  for (const { table } of SPACE_PURGE_STEPS) {
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema||'.'||table_name=$1`, [table])).rows.map((row) => row.column_name);
    const where = [
      columns.includes("space_id") ? "space_id=$1::text" : null,
      columns.includes("channel_id") ? "channel_id=ANY($2::text[])" : null,
    ].filter(Boolean);
    if (!where.length) continue;
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}
      WHERE (${where.join(" OR ")}) AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL`,
      [spaceId, channelIds]);
    if (rows[0].n) counts[table] = rows[0].n;
  }
  return counts;
}

integration("every Space- or Channel-keyed table is either purged or deliberately kept", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT DISTINCT c.table_schema||'.'||c.table_name AS name
      FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name)
      WHERE t.table_type='BASE TABLE' AND c.table_schema IN ('data','control')
        AND c.column_name IN ('space_id','channel_id','source_space_id','target_space_id')
      ORDER BY 1`);
    const classified = new Set([...SPACE_PURGE_STEPS.map((step) => step.table),
      ...Object.keys(SPACE_PURGE_EXCLUDED_TABLES)]);
    assert.deepEqual(rows.map((row) => row.name).filter((name) => !classified.has(name)), []);
    const { rows: tables } = await client.query(`SELECT table_schema||'.'||table_name AS name
      FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('data','control')`);
    const live = new Set(tables.map((row) => row.name));
    assert.deepEqual([...classified].filter((name) => !live.has(name)), [], "no step names a dropped table");
  } finally {
    await client.end();
  }
});

integration("an owner deletes a Space, may restore it, and the purge removes exactly its facts", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
  const repository = new PostgresSpaceControlRepository(database, "shard-0");
  const id = `sd-${crypto.randomUUID()}`;
  const ids = await fixture(client, repository, id);
  const at = new Date().toISOString();
  const remove = (actorUserId, commandId = crypto.randomUUID()) => repository.mutateSpace({
    requestId: commandId, commandId, actorUserId, at, kind: "space_delete", spaceId: ids.space,
  });

  await assert.rejects(remove(ids.member), code("forbidden"), "only the owner deletes a Space");
  const scheduled = await remove(ids.owner, `${id}-delete`);
  assert.equal(scheduled.deletion.state, "scheduled");
  assert.equal(Date.parse(scheduled.deletion.purgeAfter) - Date.parse(at), SPACE_DELETION_RESTORE_WINDOW_MS);
  assert.deepEqual(scheduled.recipientChanges.map((change) => change.userId).sort(),
    [ids.member, ids.owner].sort());
  assert.equal(scheduled.instancesKilled, 1);
  assert.deepEqual(scheduled.stopTargets.map((target) => target.runId), [ids.run]);
  assert.deepEqual(await remove(ids.owner, `${id}-delete`), scheduled, "a retried request replays");

  const scalar = async (text, values) => (await client.query(text, values)).rows[0];
  assert.equal((await scalar("SELECT count(*)::int AS n FROM data.space_members WHERE space_id=$1",
    [ids.space])).n, 0, "every membership is gone, so every access check fails closed");
  assert.equal((await scalar(`SELECT count(*)::int AS n FROM control.user_space_membership_routes
    WHERE space_id=$1 AND state='active'`, [ids.space])).n, 0);
  assert.equal((await scalar("SELECT status FROM data.runs WHERE run_id=$1", [ids.run])).status, "stopped");
  assert.equal((await scalar("SELECT enabled FROM data.automations WHERE automation_id=$1",
    [ids.automation])).enabled, false);
  await assert.rejects(repository.joinOpenSpace({ requestId: crypto.randomUUID(),
    commandId: crypto.randomUUID(), spaceId: ids.space, actorUserId: ids.outsider }), code("space_not_found"),
  "an open Space cannot be joined while it is being deleted");
  const repeated = await remove(ids.owner);
  assert.equal(repeated.reused, true, "the owner asking again gets the scheduled deletion back");
  assert.deepEqual(repeated.deletion, scheduled.deletion);
  assert.deepEqual(repeated.recipientChanges, []);
  assert.deepEqual((await repository.listSpaceDeletions({ requestId: "list", ownerUserId: ids.owner }))
    .map((deletion) => deletion.spaceId), [ids.space]);
  assert.deepEqual((await repository.purgeSpaceStep({ requestId: "early", spaceId: ids.space, now: at })),
    { status: "restorable", purgeAfter: scheduled.deletion.purgeAfter }, "nothing is purged early");

  const restore = (actorUserId) => repository.restoreSpace({ requestId: crypto.randomUUID(),
    commandId: crypto.randomUUID(), actorUserId, spaceId: ids.space, at: new Date().toISOString() });
  await assert.rejects(restore(ids.member), code("not_found"), "only the owner restores");
  const restored = await restore(ids.owner);
  assert.deepEqual(restored.recipientChanges.map((change) => change.change), ["granted", "granted"]);
  assert.deepEqual((await client.query(
    "SELECT user_id,role FROM data.space_members WHERE space_id=$1 ORDER BY role DESC", [ids.space])).rows,
  [{ user_id: ids.owner, role: "owner" }, { user_id: ids.member, role: "member" }]);
  assert.equal((await scalar(`SELECT count(*)::int AS n FROM control.user_space_membership_routes
    WHERE space_id=$1 AND state='active'`, [ids.space])).n, 2);
  assert.equal((await scalar("SELECT enabled FROM data.automations WHERE automation_id=$1",
    [ids.automation])).enabled, true, "the paused Automation resumes");
  assert.equal((await scalar("SELECT status FROM data.runs WHERE run_id=$1", [ids.run])).status, "stopped",
    "a stopped Run stays stopped");
  await assert.rejects(restore(ids.owner), code("not_found"), "nothing is left to restore");

  const again = await remove(ids.owner);
  const due = new Date(Date.parse(again.deletion.purgeAfter) + 1_000).toISOString();
  const deletedKeys = [];
  let step;
  for (let guard = 0; guard < 500; guard++) {
    step = await repository.purgeSpaceStep({ requestId: crypto.randomUUID(), spaceId: ids.space, now: due });
    if (step.status === "objects") {
      deletedKeys.push(...step.objectKeys);
      assert.equal(await repository.recordSpacePurgeObjects({ requestId: crypto.randomUUID(),
        spaceId: ids.space, cursor: step.cursor, exhausted: step.exhausted, deleted: step.objectKeys.length,
        now: due }), true);
      continue;
    }
    if (step.status !== "rows") break;
  }
  assert.equal(step.status, "completed");
  assert.deepEqual(deletedKeys, [ids.restrictedKey],
    "only keys scoped to this Space's own Channels are deleted; shared and foreign keys are kept");
  await assert.rejects(restore(ids.owner), code("not_found"));
  assert.deepEqual(await remaining(client, ids.space, [ids.general, ids.archived]), {});
  for (const table of ["data.spaces", "data.space_control_heads", "control.space_placement"]) {
    assert.equal((await scalar(`SELECT count(*)::int AS n FROM ${table} WHERE space_id=$1`, [ids.space])).n, 0);
  }
  const audit = await scalar("SELECT state,purged_rows,purged_objects,members_json FROM data.space_deletions WHERE space_id=$1",
    [ids.space]);
  assert.equal(audit.state, "completed");
  assert.equal(audit.members_json, null, "restore evidence goes once the purge starts");
  assert.ok(Number(audit.purged_rows) > 1_200);
  assert.equal(Number(audit.purged_objects), 1);
  assert.equal((await scalar("SELECT count(*)::int AS n FROM data.channels WHERE space_id=$1", [ids.other])).n, 1,
    "another Space is untouched");
  assert.equal((await repository.purgeSpaceStep({ requestId: "after", spaceId: ids.space, now: due })).status,
    "completed", "a late alarm sees the completed audit record");
  } finally {
    await client.end();
  }
});

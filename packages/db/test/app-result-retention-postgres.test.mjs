import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAuthorityDatabase, PostgresContentRepository } from "../dist/index.js";
import { integration, isolatedPostgres, seedOwnedTestSpace } from "./postgres-database.fixture.mjs";

const DAY = 86_400_000;
const sha = (text) => createHash("sha256").update(text).digest("hex");

// Google Cloud's Access Tools terms (and Workspace's AI Tools Addendum): what @gcp returned may stay stored at most
// 30 days, and not after the connection is disconnected. Only real PostgreSQL
// proves the tombstones, cleared summaries and released private objects together.
integration("a retained provider's results expire at their retention and at once after disconnect", async () => {
  const f = await isolatedPostgres("app_result_retention", { shard: true });
  const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const content = new PostgresContentRepository(database, "shard-0");
  const spaceId = "retention-space", owner = "retention-owner", channelId = "chan";
  const scope = `channel-user:${channelId}:${owner}`;
  const message = (id, authorKind, authorId, ageDays, sequence) => f.run(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
       message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
       legacy_body,preview_json,created_at)
      VALUES ($1,$2,$3,$4,1,$5,$6,'xmatrix.message.text','hash','hot-inline',$3,
        now()-($7::float8 * interval '1 day'),now()-($7::float8 * interval '1 day'),$3,'cost: 12.34 USD','{"text":"cost"}',
        now()-($7::float8 * interval '1 day'))`, [spaceId, channelId, id, sequence, authorKind, authorId, ageDays]);
  const execution = (id, providerId, ageDays) => f.run(`INSERT INTO data.app_connector_executions
      (execution_id,space_id,channel_id,message_id,provider_id,provider_name,status,reason,result_summary,
       requested_by,version,created_at,updated_at)
      VALUES ($1,$2,$3,$1,$4,$4,'completed','why','12.34 USD',$5,1,now()-($6::float8 * interval '1 day'),now()-($6::float8 * interval '1 day'))`,
    [id, spaceId, channelId, providerId, owner, ageDays]);
  const privateResult = async (ownerId, ageDays) => {
    const hash = sha(ownerId);
    await f.run(`INSERT INTO data.content_objects
        (space_id,object_id,object_kind,storage_key,checksum,byte_length,direct_child_count,direct_child_bytes,
         direct_children_digest,created_at,gc_not_before)
        VALUES ($1,$2,'xmatrix.blob.v1',$3,$4,10,0,0,$5,now()-($6::float8 * interval '1 day'),now()-($6::float8 * interval '1 day')+interval '31 days')`,
      [spaceId, `scoped:${scope}:sha256:${hash}`, `restricted/${encodeURIComponent(scope)}/objects/${hash}`, hash, sha(""), ageDays]);
    await f.run(`INSERT INTO data.content_refs
        (space_id,root_set_id,generation,ref_id,owner_kind,owner_id,child_object_id,child_checksum,child_bytes,logical_bytes,created_at)
        VALUES ($1,$2,0,$3,'connector_result',$4,$5,$6,10,10,now()-($7::float8 * interval '1 day'))`,
      [spaceId, scope, `connector-result:${ownerId}`, ownerId, `scoped:${scope}:sha256:${hash}`, hash, ageDays]);
    return `restricted/${encodeURIComponent(scope)}/objects/${hash}`;
  };
  try {
    await seedOwnedTestSpace(f.client, spaceId, owner);
    await f.run(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$1,$1,'open',$1,1,'{}',now(),now())`, [channelId, spaceId]);
    await f.run(`INSERT INTO data.app_connector_connections(space_id,connection_id,version,provider_id,provider_name,status,auth_mode,
      scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES($1,$1||':gcp',1,'gcp','Google Cloud','configured','oauth','[]','[]','[]','[]',$2,$1,now(),now())`, [spaceId, owner]);
    await message("system:old:gcp", "app", "gcp", 40, 1);
    await message("connector-event:gcp:old", "app", "gcp", 30, 2);
    await message("system:new:gcp", "app", "gcp", 2, 3);
    await message("user-old", "user", owner, 40, 4);
    await message("system:old:sentry", "app", "sentry", 40, 5);
    await execution("exec-old", "gcp", 40);
    await execution("exec-new", "gcp", 2);
    await execution("exec-sentry", "sentry", 40);
    const oldKey = await privateResult("system:old:gcp", 29.5);
    // An inbound event's private read (Gmail notifications) is owned by the event message id.
    const eventKey = await privateResult("app:gcp:evt-old:chan", 29.5);
    await privateResult("system:new:gcp", 2);
    await privateResult("system:old:sentry", 29.5);

    const first = await content.expireAppResults({ requestId: "expire-1", spaceId, appId: "gcp", retentionDays: 29 });
    assert.deepEqual({ messages: first.messages, executions: first.executions, refs: first.refs },
      { messages: 2, executions: 1, refs: 2 });
    const messages = Object.fromEntries((await f.run(`SELECT message_id,deleted_at IS NOT NULL AS deleted,payload_kind,
        legacy_body,preview_json FROM data.messages WHERE space_id=$1`, [spaceId])).map(row => [row.message_id, row]));
    for (const id of ["system:old:gcp", "connector-event:gcp:old"]) {
      assert.deepEqual([messages[id].deleted, messages[id].payload_kind, messages[id].legacy_body, messages[id].preview_json],
        [true, "redacted", null, null], `${id} is a tombstone`);
    }
    for (const id of ["system:new:gcp", "user-old", "system:old:sentry"]) assert.equal(messages[id].deleted, false, `${id} stays`);
    const ledger = await f.run(`SELECT message_id,actor_kind FROM data.message_mutations
      WHERE space_id=$1 AND mutation_kind='delete' ORDER BY message_id`, [spaceId]);
    assert.deepEqual(ledger.map(row => [row.message_id, row.actor_kind]),
      [["connector-event:gcp:old", "system"], ["system:old:gcp", "system"]]);
    const executions = Object.fromEntries((await f.run(`SELECT execution_id,result_summary,reason
      FROM data.app_connector_executions WHERE space_id=$1`, [spaceId])).map(row => [row.execution_id, row]));
    assert.deepEqual([executions["exec-old"].result_summary, executions["exec-old"].reason], [null, null]);
    assert.equal(executions["exec-new"].result_summary, "12.34 USD");
    assert.equal(executions["exec-sentry"].result_summary, "12.34 USD");
    assert.deepEqual((await f.run(`SELECT owner_id FROM data.content_refs WHERE space_id=$1 ORDER BY owner_id`, [spaceId]))
      .map(row => row.owner_id), ["system:new:gcp", "system:old:sentry"]);
    // The released private original is collectable now, not 31 days later.
    assert.deepEqual((await content.dueDecisionObjects({ requestId: "due-1", spaceId })).sort(), [oldKey, eventKey].sort());
    assert.ok(await content.claimDecisionObject({ requestId: "claim-1", spaceId, objectKey: oldKey }));

    const next = await content.nextAppResultsExpiry({ requestId: "next-1", spaceId, appId: "gcp", retentionDays: 29 });
    assert.ok(next !== null && Math.abs(next - (Date.now() + 27 * DAY)) < 60_000, "the 2-day-old result is next, at 29 days");
    assert.deepEqual(await content.expireAppResults({ requestId: "expire-2", spaceId, appId: "gcp", retentionDays: 29 })
      .then(({ messages, executions, refs }) => ({ messages, executions, refs })), { messages: 0, executions: 0, refs: 0 });

    // Disconnected: nothing it returned may remain.
    await f.run("UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id=$1 AND provider_id='gcp'", [spaceId]);
    assert.ok((await content.nextAppResultsExpiry({ requestId: "next-2", spaceId, appId: "gcp", retentionDays: 29 })) <= Date.now());
    const gone = await content.expireAppResults({ requestId: "expire-3", spaceId, appId: "gcp", retentionDays: 29 });
    assert.deepEqual({ messages: gone.messages, executions: gone.executions, refs: gone.refs }, { messages: 1, executions: 1, refs: 1 });
    assert.equal(await content.nextAppResultsExpiry({ requestId: "next-3", spaceId, appId: "gcp", retentionDays: 29 }), null);
    assert.equal((await f.run(`SELECT count(*)::int AS n FROM data.messages WHERE space_id=$1 AND deleted_at IS NULL`, [spaceId]))[0].n, 2,
      "the person's message and the other provider's receipt stay");
  } finally { await f.close(); }
});

import { connectionString as url, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";

import { createAuthorityDatabase } from "../dist/client.js";
import { PostgresMessageRepository } from "../dist/message-control.js";
import { PostgresSpacePlacementDirectory } from "../dist/placement.js";
import { PostgresSpaceControlRepository } from "../dist/space-control.js";

// Runs against a fully migrated database (`scripts/migrate.mjs apply`).

async function seed(sql, id) {
  const space = `space-${id}`, channel = `channel-${id}`, thread = `thread-${id}`;
  const closedThread = `closed-thread-${id}`, legacy = `legacy-${id}`;
  const reader = `reader-${id}`, author = `author-${id}`;
  await sql(`INSERT INTO control.postgres_shards VALUES ('shard-0','active','shard-0',now(),now())
    ON CONFLICT DO NOTHING`);
  await sql(`INSERT INTO control.space_placement (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
    VALUES ($1,'shard-0',1,'active','standard',now(),now())`, [space]);
  await sql(`INSERT INTO control.channel_space_routes
    (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
    VALUES ($1,$2,'shard-0',1,1,'active',now())`, [channel, space]);
  await sql(`INSERT INTO control.channel_space_directory (channel_id,space_id,updated_at)
    VALUES ($1,$2,now())`, [legacy, space]);
  await sql(`INSERT INTO data.spaces
    (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,'History',$1,1,'{}',now(),now())`, [space, author]);
  await sql(`INSERT INTO data.space_members (space_id,user_id,role,display_name,version,created_at,updated_at)
    VALUES ($1,$2,'member','Reader',1,now(),now()),($1,$3,'owner','Ada Author',1,now(),now())`,
  [space, reader, author]);
  const channelRow = (channelId, mode, metadata) => sql(`INSERT INTO data.channels
    (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$1,$1,$3,$1,1,$4::jsonb,now(),now())`, [channelId, space, mode, JSON.stringify(metadata)]);
  await channelRow(channel, "open", {});
  await channelRow(thread, "open", { kind: "thread", threadRootChannelId: channel,
    threadRootMessageId: `${channel}-1`, threadRootCopyMessageId: `${thread}-copy` });
  // A closed Thread the reader holds no grant for must not surface a summary.
  await channelRow(closedThread, "closed", { kind: "thread", threadRootChannelId: channel,
    threadRootMessageId: `${channel}-2` });
  const message = (channelId, messageId, sequence, overrides = {}) => sql(`INSERT INTO data.messages
    (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,
     content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,created_at,
     payload_bundle_base64,attachments_json,recalled_at)
    VALUES ($1,$2,$3,$4,1,'user',$5,'message','hash','inline','inline',
      timestamptz '2026-09-01T00:00:00Z' + $4::bigint * interval '1 minute',now(),$3,now(),$6,$7::jsonb,$8)`,
  [space, channelId, messageId, sequence, author, overrides.bundle === undefined ? "bundle" : overrides.bundle,
    JSON.stringify(overrides.attachments ?? []), overrides.recalledAt ?? null]);
  await message(channel, `${channel}-1`, 1);
  await message(channel, `${channel}-2`, 2);
  await message(channel, `${channel}-3`, 3, { attachments: [{ id: "legacy-image", contentHash: "c".repeat(64) }] });
  await message(channel, `${channel}-4`, 4, { bundle: null, recalledAt: "2026-09-02T00:00:00Z" });
  await message(thread, `${thread}-copy`, 1);
  for (const sequence of [2, 3, 4]) await message(thread, `${thread}-${sequence}`, sequence);
  await sql(`INSERT INTO data.message_attachment_refs
    (space_id,attachment_id,message_id,channel_id,object_key,content_hash,encoded_bytes,mime_type,name,
     version,created_at,updated_at)
    VALUES ($1,'legacy-image',$2,$3,'objects/legacy',$4,4,'image/png','a.png',3,now(),now())`,
  [space, `${channel}-3`, channel, "c".repeat(64)]);
  await sql(`INSERT INTO data.delivery_cursors (space_id,subject_id,channel_id,acknowledged_sequence,version,updated_at)
    VALUES ($1,$2,$3,2,1,now())`, [space, `user:${reader}`, channel]);
  await sql(`INSERT INTO data.channel_content_counters (space_id,channel_id,content_revision,updated_at)
    VALUES ($1,$2,7,now())`, [space, channel]);
  return { space, channel, thread, legacy, reader, author };
}

async function cleanup(sql, space) {
  for (const table of ["message_attachment_refs", "delivery_cursors", "channel_content_counters",
    "messages", "channels", "space_members", "spaces"]) {
    await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [space]).catch(() => {});
  }
  for (const table of ["channel_space_routes", "channel_space_directory", "space_placement"]) {
    await sql(`DELETE FROM control.${table} WHERE space_id=$1`, [space]).catch(() => {});
  }
}

/** Records every statement a request sends, through the session history opens. */
function queryCounter(database) {
  const names = [];
  const counted = (target) => ({
    cacheMode: "disabled",
    openSession: () => counted(target.openSession()),
    close: () => target.close(),
    health: (context) => target.health(context),
    transaction: (context, callback) => target.transaction(context, (transaction) => callback({
      query: (query) => { names.push(query.name); return transaction.query(query); },
    })),
  });
  return { names, database: counted(database) };
}

/** Seeds one Space, runs `body`, and always removes the Space again. */
async function withSeededSpace(prefix, body) {
  const setup = new Client({ connectionString: url }); await setup.connect();
  const sql = (text, values) => setup.query(text, values);
  const id = `${prefix}-${process.pid}-${Date.now()}`;
  const database = createAuthorityDatabase({ connectionString: url, shardId: "shard-0", connectTimeoutMs: 60_000 });
  let space;
  try {
    const seeded = await seed(sql, id);
    space = seeded.space;
    await body({ sql, id, database, seeded, space });
  } finally {
    if (space) await cleanup(sql, space);
    await setup.end();
  }
}

integration("one fenced statement reads the authorized page, its Thread summaries and its head", () => withSeededSpace("history", async ({ sql, id, database, seeded, space }) => {
  const control = new PostgresSpaceControlRepository(database, "shard-0");
  const resolved = await control.resolveChannelSpacePlacement({ requestId: `${id}-route`, channelId: seeded.channel });
  // The combined directory read answers exactly what the two separate reads answer.
  assert.equal(resolved.spaceId,
    await control.resolveChannelSpaceId({ requestId: `${id}-id`, channelId: seeded.channel }));
  assert.deepEqual(resolved.placement, await new PostgresSpacePlacementDirectory(database)
    .resolve({ requestId: `${id}-placement`, operation: "test" }, space));
  const legacy = await control.resolveChannelSpacePlacement({ requestId: `${id}-legacy`, channelId: seeded.legacy });
  assert.equal(legacy.spaceId, space);
  await assert.rejects(control.resolveChannelSpacePlacement({ requestId: `${id}-missing`,
    channelId: `missing-${id}` }), (error) => error.code === "channel_not_found");

  const counted = queryCounter(database);
  const repository = new PostgresMessageRepository(counted.database);
  const scope = { requestId: `${id}-history`, spaceId: space, channelId: seeded.channel,
    principal: { kind: "user", id: seeded.reader }, resolvedPlacement: resolved.placement };
  const newest = await repository.history({ ...scope, limit: 3 });
  assert.deepEqual(newest.messages.map((message) => message.messageId),
    [`${seeded.channel}-2`, `${seeded.channel}-3`, `${seeded.channel}-4`]);
  assert.equal(newest.hasMore, true);
  assert.equal(newest.historyHeadSequence, 4);
  assert.equal(newest.principalAckedSequence, 2);
  assert.equal(newest.contentRevision, 7);
  assert.equal(newest.messages[0].threadSummary, undefined, "a closed Thread stays hidden");
  assert.equal(newest.messages[1].attachments[0].version, 3, "a legacy attachment edge recovers its version");
  assert.equal(newest.messages[2].tombstoneSender.label, "Ada Author", "a recalled row names its author");
  assert.deepEqual(counted.names, ["message_history_page_v3",
    "message_history_attachment_versions_v1", "message_history_tombstone_senders_v1"]);

  counted.names.length = 0;
  const oldest = await repository.history({ ...scope, afterSequence: 0, limit: 1 });
  assert.deepEqual(oldest.messages.map((message) => message.messageId), [`${seeded.channel}-1`]);
  assert.equal(oldest.hasMore, true);
  const summary = oldest.messages[0].threadSummary;
  assert.equal(summary.channelId, seeded.thread);
  assert.equal(summary.replyCount, 3, "the root copy is not a reply");
  assert.deepEqual(summary.replies.map((reply) => reply.messageId), [`${seeded.thread}-3`, `${seeded.thread}-4`]);
  assert.deepEqual(counted.names, ["message_history_page_v3"],
    "a page without legacy attachments or tombstones is one statement");

  const before = await repository.history({ ...scope, beforeSequence: 2 });
  assert.deepEqual(before.messages.map((message) => message.messageId), [`${seeded.channel}-1`]);
  assert.equal(before.hasMore, false);
  const timed = await repository.history({ ...scope, before: "2026-09-01T00:02:30Z" });
  assert.deepEqual(timed.messages.map((message) => message.sequence), [1, 2]);

  for (const principal of [{ kind: "user", id: `stranger-${id}` }, { kind: "agent", id: `instance-${id}` }]) {
    await assert.rejects(repository.history({ ...scope, principal }),
      (error) => error.code === "channel_not_found", `${principal.kind} outside the Channel is refused`);
  }
  await assert.rejects(repository.history({ ...scope, resolvedPlacement: { ...resolved.placement, placementEpoch: 2 } }),
    /local Space placement fence is stale/u);
  await sql("UPDATE control.space_placement SET state='blocked' WHERE space_id=$1", [space]);
  await assert.rejects(repository.history(scope), /local Space placement fence is stale/u,
    "a Space blocked after its route was read is refused");
}));

integration("search candidates cover only readable live messages, newest first, with a rank cursor", () => withSeededSpace("search", async ({ sql, id, database, seeded, space }) => {
  await sql(`INSERT INTO data.messages
    (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,
     content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,created_at,payload_bundle_base64)
    VALUES ($1,$2,$3,1,1,'user',$4,'message','hash','inline','inline',now(),now(),$3,now(),'bundle')`,
  [space, `closed-thread-${id}`, `closed-thread-${id}-1`, seeded.author]);
  const repository = new PostgresMessageRepository(database);
  const read = (beforeRank, limit = 50) => repository.searchCandidates({ requestId: `${id}-${limit}`,
    spaceId: space, principal: { kind: "user", id: seeded.reader }, beforeRank, limit });
  const all = await read(undefined);
  const ids = all.map((candidate) => candidate.messageId);
  assert.deepEqual(ids, [...ids].sort().reverse(), "candidates arrive newest rank first");
  assert.ok(!ids.includes(`${seeded.channel}-4`), "a recalled message is not a candidate");
  assert.ok(!ids.includes(`closed-thread-${id}-1`), "a closed Channel without a grant stays hidden");
  assert.equal(ids.length, 7);
  const first = await read(undefined, 3);
  const next = await read(first.at(-1).searchRankSequence, 50);
  assert.deepEqual([...first, ...next].map((candidate) => candidate.messageId), ids);
  const outsider = await repository.searchCandidates({ requestId: `${id}-outsider`, spaceId: space,
    principal: { kind: "user", id: `outsider-${id}` }, limit: 50 });
  assert.deepEqual(outsider, [], "a non-member reads nothing");
  const inChannel = await repository.searchCandidates({ requestId: `${id}-in`, spaceId: space,
    principal: { kind: "user", id: seeded.reader }, channelId: seeded.channel, limit: 50 });
  assert.deepEqual(inChannel.map((candidate) => candidate.messageId), ids,
    "a Channel filter includes its readable threads and excludes the closed thread");
  assert.ok(inChannel.some((candidate) => candidate.channelId === seeded.thread));
  const inThread = await repository.searchCandidates({ requestId: `${id}-in-thread`, spaceId: space,
    principal: { kind: "user", id: seeded.reader }, channelId: seeded.thread, limit: 50 });
  assert.equal(inThread.length, 4);
  assert.ok(inThread.every((candidate) => candidate.channelId === seeded.thread),
    "a thread filter does not include its parent conversation");
  const inClosedThread = await repository.searchCandidates({ requestId: `${id}-in-closed`, spaceId: space,
    principal: { kind: "user", id: seeded.reader }, channelId: `closed-thread-${id}`, limit: 50 });
  assert.deepEqual(inClosedThread, [], "a Channel filter cannot grant access");
  const byAuthor = await repository.searchCandidates({ requestId: `${id}-from`, spaceId: space,
    principal: { kind: "user", id: seeded.reader }, authorKind: "user", authorId: seeded.author, limit: 50 });
  assert.ok(byAuthor.length > 0 && byAuthor.every((candidate) => candidate.authorId === seeded.author),
    "an author filter keeps only that author's messages");
  const byStranger = await repository.searchCandidates({ requestId: `${id}-from-none`, spaceId: space,
    principal: { kind: "user", id: seeded.reader }, authorKind: "user", authorId: `nobody-${id}`, limit: 50 });
  assert.deepEqual(byStranger, [], "an author with no messages finds nothing");
}));

import assert from "node:assert/strict";
import test from "node:test";

import { createAuthorityDatabaseRouter } from "../dist/router.js";
import { ContentControlError, PostgresContentRepository } from "../dist/content-control.js";
import { registeredRunRows } from './registered-run.fixture.mjs';
import { activePlacementRow, dedicatedPlacementRow, routedEntityDirectory, publicationPlacement, recordingDatabase as database } from "./recording-database.fixture.mjs";

test("content upload intent is authorized, idempotent, and auditable in PostgreSQL", async () => {
  const db = database((query) => publicationPlacement(query) ?? ( query.name === "content_entity_route_source_v1"
        ? [{ route_version: 4, updated_at: new Date("2026-08-30T00:00:00.000Z") }]
    : query.name === "content_authorize_user_v2"
      ? [{ role: "member" }]
      : query.name === "content_head_advance_v1"
        ? [{ commit_sequence: 4 }]
        : []));
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const result = await new PostgresContentRepository(db, "shard-0").createIntent({
    requestId: "request-1", commandId: "command-1", intentId: "intent-1",
    scopeId: "space:space-1", contentHash: "1".repeat(64), encodedBytes: 100,
    expiresAt, principal: { kind: "user", id: "user-1" },
  });

  assert.equal(result.objectKey, `objects/${"1".repeat(64)}`);
  for (const name of ["content_intent_insert_v1", "content_outbox_v1", "content_idempotency_write_v1"]) {
    assert.equal(db.calls.some((call) => call.name === name), true, name);
  }
  assert.equal(db.calls.some((call) => call.name === "entity_space_route_publish_v1"), true);
  assert.equal(
    db.calls.find((call) => call.name === "entity_space_route_publish_v1").values[8],
    "2026-08-30T00:00:00.000Z",
  );
});

test("content authority rejects cached PostgreSQL", () => {
  assert.throws(
    () => new PostgresContentRepository({ cacheMode: "cached" }, "shard-0"),
    (error) => error instanceof ContentControlError && error.code === "cached_authority_forbidden",
  );
});

test("content authority follows a Space placement beyond the default shard", async () => {
  const directory = database((query) => query.name === "space_placement_resolve_v1"
    ? [dedicatedPlacementRow()]
    : query.name === "entity_space_route_placement_fence_v1"
      ? [{ shard_id: "shard-1", placement_epoch: 7 }]
    : []);
  const shard0 = database(() => []);
  const shard1 = database((query) => query.name === "content_authorize_user_v2"
    ? [{ role: "member" }]
    : query.name === "content_head_advance_v1" ? [{ commit_sequence: 4 }]
      : query.name === "content_entity_route_source_v1"
        ? [{ route_version: 4, updated_at: "2026-08-30T00:00:00.000Z" }] : []);
  const router = createAuthorityDatabaseRouter({ directory, shards: { "shard-0": shard0,
    "shard-1": shard1 } });
  const result = await new PostgresContentRepository(router, "shard-0").createIntent({
    requestId: "request-routed", commandId: "command-routed", intentId: "intent-routed",
    scopeId: "space:space-1", contentHash: "2".repeat(64), encodedBytes: 100,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    principal: { kind: "user", id: "user-1" },
  });

  assert.equal(result.objectKey, `objects/${"2".repeat(64)}`);
  assert.equal(directory.calls.some((call) => call.name === "space_placement_resolve_v1"), true);
  assert.equal(shard1.calls.some((call) => call.name === "content_intent_insert_v1"), true);
  assert.equal(shard0.calls.some((call) => call.name === "content_intent_insert_v1"), false);
  assert.equal(directory.calls.some((call) => call.name === "entity_space_route_publish_v1"), true);
});

test("content intent reads route an opaque ID through the global entity directory", async () => {
  const directory = routedEntityDirectory({ entity_kind: "content-intent", entity_id: "intent-routed", space_id: "space-1",
        shard_id: "shard-1", placement_epoch: 7, entity_version: 1, route_version: 4 });
  const shard0 = database(() => []);
  const shard1 = database((query) => query.name === "content_intent_locate_routed_v1"
    ? [{ space_id: "space-1", scope_id: "space:space-1" }]
    : query.name === "content_authorize_user_v2" ? [{ role: "member" }]
      : query.name === "content_intent_read_v1" ? [{ intent_id: "intent-routed",
        scope_id: "space:space-1", content_hash: "3".repeat(64), object_key: "objects/key",
        encoded_bytes: 100, checksum: "3".repeat(64), status: "pending", version: 1,
        created_at: "2026-08-30T00:00:00.000Z", expires_at: "2026-08-30T01:00:00.000Z" }]
        : []);
  const router = createAuthorityDatabaseRouter({ directory, shards: { "shard-0": shard0,
    "shard-1": shard1 } });

  const result = await new PostgresContentRepository(router, "shard-0").readIntent({
    requestId: "request-read-routed", intentId: "intent-routed",
    principal: { kind: "user", id: "user-1" },
  });

  assert.equal(result.intentId, "intent-routed");
  assert.equal(shard1.calls.some((call) => call.name === "content_intent_locate_routed_v1"), true);
  assert.equal(shard0.calls.some((call) => call.name === "content_intent_locate_routed_v1"), false);
});

test('restricted channel payload requires its named user and current channel access for reads and replay', async () => {
  let allowed = true;
  let scopeId = 'channel-user:channel-1:user-1';
  const row = { ref_id: 'ref-1', root_set_id: scopeId, owner_kind: 'summon-decision', owner_id: 'message-1',
    checksum: '4'.repeat(64), storage_key: `objects/${'4'.repeat(64)}`, byte_length: 100, created_at: new Date() };
  const db = database(query => {
    if (query.name === 'space_placement_resolve_v1') return [activePlacementRow()];
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'channel-1', space_id: 'space-1', shard_id: 'shard-0', placement_epoch: 1, entity_version: 1 }];
    if (query.name === 'content_ref_locate_legacy_v1') return [{ space_id: 'space-1', root_set_id: scopeId }];
    if (query.name.startsWith('channel_capability_content_')) return allowed ? [{ channel_id: 'channel-1', space_id: 'space-1', mode: 'open', archived_at: null, space_role: 'member' }] : [];
    if (query.name === 'content_ref_read_v1') return [row];
    if (query.name === 'content_idempotency_read_v1') throw new Error('replay was reached after access revocation');
    return [];
  });
  const repository = new PostgresContentRepository(db, 'shard-0');
  const input = { requestId: 'read-1', refId: 'ref-1', principal: { kind: 'user', id: 'user-1' } };
  assert.equal((await repository.readRef(input)).objectKey, row.storage_key);
  row.owner_kind = 'summon_decision';
  await assert.rejects(repository.readRef(input), error => error.code === 'decision_reader_required');
  row.owner_kind = 'summon-decision';
  for (const principal of [{ kind: 'user', id: 'other-user' }, { kind: 'agent', id: 'user-1' }]) {
    const before = db.calls.filter(call => call.name === 'content_ref_read_v1').length;
    await assert.rejects(repository.readRef({ ...input, principal }), error => error.code === 'forbidden');
    assert.equal(db.calls.filter(call => call.name === 'content_ref_read_v1').length, before);
  }
  allowed = false;
  await assert.rejects(repository.readRef(input), error => error.status === 404);
  await assert.rejects(repository.createIntent({ requestId: 'create-1', commandId: 'replay-1', intentId: 'intent-1',
    scopeId, contentHash: '4'.repeat(64), encodedBytes: 100, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    principal: input.principal }), error => error.status === 404);
  for (const malformed of ['channel-user:channel-1:user-1:extra', 'channel-user:channel-1:%75ser-1', 'channel-user::user-1']) {
    scopeId = malformed;
    await assert.rejects(repository.readRef(input), error => error.code === 'invalid_command');
  }
});

test('decision listing binds source author, current channel, restricted root and bounded page', async () => {
  let allowed = true, unchanged = true;
  const db = database(query => {
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'channel', space_id: 'space', shard_id: 'shard', placement_epoch: 1, entity_version: 1 }];
    if (query.name === 'space_placement_resolve_v1') return [activePlacementRow("space", { shardId: "shard" })];
    if (query.name === 'channel_capability_content_history_read_v3') return allowed ? [{ channel_id: 'channel', space_id: 'space', mode: 'open', metadata_json: {}, version: 1 }] : [];
    if (query.name === 'runtime_initial_message_source_v4') return unchanged && query.values[3] === 'author'
      ? [{ entity_version: 1, body_hash: 'a'.repeat(64), timeline_sequence: 1 }] : [];
    if (query.name === 'content_summon_decision_refs_v1') {
      assert.deepEqual(query.values.slice(0, 3), ['space', 'channel-user:channel:author', 'message']);
      assert.equal(query.values[6], 3);
      assert.equal(query.maxRows, 3);
      assert.match(query.text, /owner_kind='summon_decision'/);
      assert.match(query.text, /created_at > \$4/);
      return ['a', 'b', 'c'].map(ref_id => (decisionRef(ref_id, query.values[1])));
    }
    return [];
  });
  const repository = new PostgresContentRepository(db, 'shard');
  const input = decisionRead({ kind: 'user', id: 'author' }, { limit: 2 });
  const result = await repository.summonDecisionRefs(input);
  assert.deepEqual(result.refs.map(ref => ref.refId), ['a', 'b']);
  assert.equal(result.nextCursor, 'b');
  await assert.rejects(repository.summonDecisionRefs({ ...input, principal: { kind: 'user', id: 'other' } }), error => error.status === 404);
  await assert.rejects(repository.summonDecisionRefs({ ...input, principal: { kind: 'agent', id: 'author' } }), error => error.status === 403);
  unchanged = false;
  await assert.rejects(repository.summonDecisionRefs(input), error => error.status === 404);
  unchanged = true; allowed = false;
  await assert.rejects(repository.summonDecisionRefs(input), error => error.status === 404);
  assert.equal(db.calls.filter(query => query.name === 'content_summon_decision_refs_v1').length, 1);
});

test('decision expiry rejects unbounded batch sizes before accessing authority', async () => {
  const db = database(() => assert.fail('invalid batch must not access PostgreSQL'));
  const repository = new PostgresContentRepository(db, 'shard');
  for (const limit of [0, -1, 101, 1.5, NaN]) {
    await assert.rejects(repository.expireDecisionRefs({ requestId: 'expire', spaceId: 'space', limit }));
    await assert.rejects(repository.dueDecisionObjects({ requestId: 'due', spaceId: 'space', limit }));
  }
  assert.equal(db.calls.length, 0);
});

test('collector refuses ordinary content keys before accessing authority', async () => {
  const db = database(() => assert.fail('invalid key must not access PostgreSQL'));
  const repository = new PostgresContentRepository(db, 'shard');
  for (const objectKey of ['objects/' + 'a'.repeat(64), 'restricted/space%3Aspace/objects/' + 'a'.repeat(64)]) {
    await assert.rejects(repository.claimDecisionObject({ requestId: 'collect', spaceId: 'space', objectKey }));
  }
  assert.equal(db.calls.length, 0);
});

test('Agent decision evidence derives Human root after exact Run and both Channel grants', async () => {
  let allowed = true, status = 'running', runOwner = 'agent-owner', sourceOwner = 'human-author';
  const db = database(query => {
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'channel', space_id: 'space', shard_id: 'shard', placement_epoch: 1, entity_version: 1 }];
    if (query.name === 'space_placement_resolve_v1') return [activePlacementRow("space", { shardId: "shard" })];
    if (query.name === 'agent_channel_registered_run_access_v2') return [{ owner_user_id: runOwner, channel_id: 'birth',
      instance_channel_id: 'birth', status, metadata_json: { executionKey: 'execution' } }];
    if (query.name === 'channel_capability_content_history_read_v3') return allowed ? [{ channel_id: query.values[0],
      space_id: 'space', mode: 'open', metadata_json: {}, version: 1 }] : [];
    const admission = registeredRunRows(query, { runId: 'run', spaceId: 'space', channelId: 'birth', ownerUserId: runOwner });
    if (admission) return admission;
    if (query.name === 'content_decision_source_owner_v3') return [{ owner_user_id: sourceOwner }];
    if (query.name === 'runtime_initial_message_source_v4') {
      assert.equal(query.values[3], sourceOwner);
      return [{ entity_version: 1, body_hash: 'a'.repeat(64), timeline_sequence: 1 }];
    }
    if (query.name === 'content_summon_decision_refs_v1') {
      assert.equal(query.values[1], 'channel-user:channel:human-author');
      return [decisionRef('ref', query.values[1])];
    }
    return [];
  });
  const repository = new PostgresContentRepository(db, 'shard');
  const input = decisionRead({ kind: 'agent', id: 'agent' }, {
    runProof: { runId: 'run', instanceId: 'instance', executionKey: 'execution' } });
  assert.equal((await repository.summonDecisionRefs(input)).refs[0].refId, 'ref');
  const checks = db.calls.filter(call => call.name === 'channel_capability_content_history_read_v3');
  assert.deepEqual(checks.map(call => [call.values[0], call.values[2], call.values[3]]),
    [['birth', 'agent', 'agent'], ['birth', 'user', runOwner], ['channel', 'agent', 'agent'], ['channel', 'user', runOwner]]);
  await assert.rejects(repository.summonDecisionRefs({ ...input, runProof: { ...input.runProof, executionKey: 'wrong' } }), error => error.status === 403);
  status = 'completed';
  await assert.rejects(repository.summonDecisionRefs(input), error => error.status === 403);
  status = 'running'; allowed = false;
  await assert.rejects(repository.summonDecisionRefs(input), error => error.status === 404);
  assert.equal(db.calls.filter(call => call.name === 'content_summon_decision_refs_v1').length, 1);
});

test('a Space-scope upload is referenced into a Channel of that Space, whose scope the ref carries', async () => {
  const hash = '5'.repeat(64);
  let intentScope = 'space:space-1';
  const db = database(query => {
    if (query.name === 'space_placement_resolve_v1') return [activePlacementRow()];
    if (query.name === 'entity_space_route_placement_fence_v1') return [{ shard_id: 'shard-0', placement_epoch: 1 }];
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'closed-1', space_id: 'space-1', shard_id: 'shard-0', placement_epoch: 1, entity_version: 1 }];
    if (query.name.startsWith('channel_capability_content_')) return [{ channel_id: 'closed-1', space_id: 'space-1', mode: 'closed', archived_at: null, space_role: 'member' }];
    if (query.name === 'content_ref_intent_lock_v1') return [{ status: 'pending', version: 1, scope_id: intentScope,
      object_key: `objects/${hash}`, checksum: hash, encoded_bytes: 100, expires_at: new Date(Date.now() + 60_000) }];
    if (query.name === 'content_head_advance_v1') return [{ commit_sequence: 5 }];
    if (query.name === 'content_entity_route_source_v1') return [{ route_version: 1, updated_at: new Date() }];
    return [];
  });
  const repository = new PostgresContentRepository(db, 'shard-0');
  const commit = (commandId) => repository.commitRef({ requestId: commandId, commandId, intentId: 'intent-1',
    expectedIntentVersion: 1, refId: `ref-${commandId}`, ownerKind: 'message_attachment', ownerId: 'message-1',
    scopeId: 'channel:closed-1', objectKey: `objects/${hash}`, checksum: hash, encodedBytes: 100,
    verifiedAt: new Date().toISOString(), principal: { kind: 'user', id: 'user-1' } });
  assert.equal((await commit('commit-1')).scopeId, 'channel:closed-1');
  const inserted = db.calls.find(call => call.name === 'content_ref_insert_v1');
  assert.equal(inserted.values[1], 'channel:closed-1');
  for (const scope of ['space:space-2', 'channel:other-1']) {
    intentScope = scope;
    await assert.rejects(commit(`commit-${scope}`), error => error.code === 'blob_object_mismatch');
  }
});

function decisionRef(ref_id, root_set_id) {
  return { ref_id, root_set_id, owner_kind: 'summon_decision', owner_id: 'message',
    checksum: 'a'.repeat(64), storage_key: 'restricted/key', byte_length: 10, created_at: new Date() };
}

function decisionRead(principal, options) {
  return { requestId: 'read', channelId: 'channel', sourceMessageId: 'message', principal, ...options };
}

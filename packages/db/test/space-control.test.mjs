import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthorityDatabase,
  DatabaseContractError,
} from "../dist/index.js";
import {
  PostgresSpaceControlRepository,
  SpaceControlError,
} from "../dist/space-control.js";
import { activePlacementRow, recordingDatabase as database } from "./recording-database.fixture.mjs";

function spaceMutationRow(version) {
  return { space_id: "space-1", owner_user_id: "owner-1", name: "One", metadata_json: {},
    version, search_rank_sequence: "pg:1", created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z" };
}

test("Space authority creates placement, owner, billing, outbox, and idempotency atomically", async () => {
  const db = database((query) => query.name === "space_shard_admission_v1"
    ? [{ state: "active" }]
    : query.name === "space_search_rank_allocate_v1"
      ? [{ value: "pg:00000000000000000001" }]
      : []);
  const repository = new PostgresSpaceControlRepository(db, "shard-0");
  const result = await repository.createSpace({
    requestId: "request-1",
    commandId: "command-1",
    spaceId: "space-1",
    ownerUserId: "user-1",
    name: "One",
    metadata: { purpose: "test" },
  });

  assert.equal(result.id, "space-1");
  assert.equal(result.ownerUserId, "user-1");
  for (const queryName of [
    "space_placement_create_v1",
    "space_create_v2",
    "space_owner_create_v1",
    "user_space_directory_create_v1",
    "space_control_head_create_v1",
    "space_create_outbox_v1",
    "space_control_idempotency_write_v1",
  ]) assert.equal(db.calls.some((call) => call.name === queryName), true, queryName);
  assert.equal(db.calls.filter((call) => call.context).length, 1);
});

test("Space authority closes only new-Space admission while the shard drains", async () => {
  const db = database((query) => query.name === "space_shard_admission_v1"
    ? [{ state: "draining" }]
    : []);
  const repository = new PostgresSpaceControlRepository(db, "shard-0");
  await assert.rejects(repository.createSpace({
    requestId: "request-draining", commandId: "command-draining", spaceId: "space-new",
    ownerUserId: "user-1", name: "New",
  }), (error) => error instanceof SpaceControlError &&
    error.code === "postgres_shard_admission_closed" && error.status === 503 &&
    error.retryable === true && error.details?.state === "draining");
  assert.equal(db.calls.some((call) => call.name === "space_placement_create_v1"), false);
  assert.equal(db.calls.some((call) => call.name === "space_search_rank_allocate_v1"), false);
});

test("Space authority rejects a reused command id with another digest", async () => {
  const db = database((query) => query.name === "space_control_idempotency_read_v1"
    ? [{ command_kind: "create-space", request_digest: "0".repeat(64), result_json: { id: "space-1" } }]
    : []);
  const repository = new PostgresSpaceControlRepository(db, "shard-0");
  await assert.rejects(repository.createSpace({
    requestId: "request-1", commandId: "command-1", spaceId: "space-1",
    ownerUserId: "user-1", name: "One",
  }), (error) => error instanceof SpaceControlError && error.code === "idempotency_conflict");
  assert.equal(db.calls.some((call) => call.name === "space_create_v2"), false);
});

test("Space authority rejects cached databases", () => {
  assert.throws(
    () => new PostgresSpaceControlRepository({ cacheMode: "cached" }, "shard-0"),
    (error) => error instanceof SpaceControlError && error.code === "cached_authority_forbidden",
  );
});

test("Channel catalog change audiences bind one revision to exact current Space members", async () => {
  const db = database((query) => {
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow("space-1", { placementEpoch: 3 })];
    if (query.name === "channel_catalog_change_audience_v2") return [
      { commit_sequence: "12", user_id: "user-1" },
      { commit_sequence: "12", user_id: "user-2" },
    ];
    return [];
  });
  const result = await new PostgresSpaceControlRepository(db, "shard-0")
    .channelCatalogChangeAudiences({
      requestId: "request-catalog-change", spaceIds: ["space-1", "space-1"],
    });
  assert.deepEqual(result, [{
    spaceId: "space-1", revision: 12, recipientUserIds: ["user-1", "user-2"],
  }]);
  const audienceQuery = db.calls.find(
    (call) => call.name === "channel_catalog_change_audience_v2",
  );
  assert.equal(audienceQuery.maxRows, 10_000);
  assert.deepEqual(audienceQuery.values, ["space-1", null]);
});

test("catalog audience pages within the database row limit without dropping members", async () => {
  const members = Array.from({ length: 10_001 }, (_, index) => ({ commit_sequence: "12",
    user_id: `user-${String(index).padStart(6, "0")}` }));
  const db = database(query => {
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow("space-1", { placementEpoch: 3 })];
    if (query.name === "channel_catalog_change_audience_v2") {
      assert.equal(query.maxRows, 10_000);
      return members.filter(row => query.values[1] === null || row.user_id > query.values[1]).slice(0, 10_000);
    }
    return [];
  });
  const [result] = await new PostgresSpaceControlRepository(db, "shard-0")
    .channelCatalogChangeAudiences({ requestId: "paged-catalog", spaceIds: ["space-1"] });
  assert.deepEqual(result.recipientUserIds, members.map(row => row.user_id));
  assert.equal(db.calls.filter(query => query.name === "channel_catalog_change_audience_v2").length, 2);
});

test("catalog pagination preserves the existing total fanout bound", async () => {
  let pages = 0;
  const db = database(query => {
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow("space-1", { placementEpoch: 3 })];
    if (query.name !== "channel_catalog_change_audience_v2") return [];
    const start = pages++ * 10_000;
    return Array.from({ length: pages === 11 ? 1 : 10_000 }, (_, index) => ({
      commit_sequence: "12", user_id: `user-${String(start + index).padStart(6, "0")}`,
    }));
  });
  await assert.rejects(new PostgresSpaceControlRepository(db, "shard-0")
    .channelCatalogChangeAudiences({ requestId: "oversize-catalog", spaceIds: ["space-1"] }),
    error => error.code === "catalog_change_audience_too_large");
  assert.equal(pages, 11);
});

test("Space update resolves the current PostgreSQL version when the product route omits it", async () => {
  const db = database((query) => query.name === "space_placement_resolve_v1"
    ? [activePlacementRow()]
    : query.name === "space_mutation_lock_v2"
      ? [spaceMutationRow(4)]
      : query.name === "space_mutation_actor_v1"
        ? [{ role: "admin" }]
        : query.name === "space_update_v2"
          ? [{ space_id: "space-1" }]
          : query.name === "space_mutation_head_v1"
            ? [{ commit_sequence: 8 }]
            : []);
  const result = await new PostgresSpaceControlRepository(db, "shard-0").mutateSpace({
    requestId: "request-space-update", commandId: "command-space-update",
    actorUserId: "admin-1", at: "2026-08-31T00:00:00.000Z",
    kind: "space_update", spaceId: "space-1", name: "Renamed",
  });

  assert.equal(result.entityVersion, 5);
  assert.deepEqual(db.calls.find((call) => call.name === "space_update_v2").values.slice(-2), [
    "2026-08-31T00:00:00.000Z", 4,
  ]);
});

test("Space deletion revokes every membership and schedules a restorable purge atomically", async () => {
  const db = database((query) => query.name === "space_placement_resolve_v1"
    ? [activePlacementRow()]
    : query.name === "space_mutation_lock_v2"
      ? [spaceMutationRow(3)]
      : query.name === "space_mutation_actor_v1"
        ? [{ role: "owner" }]
        : query.name === "space_delete_advance_v1"
          ? [{ space_id: "space-1" }]
          : query.name === "space_mutation_head_v1"
            ? [{ commit_sequence: 4 }]
            : query.name === "space_deletion_member_snapshot_v1"
              ? [{ user_id: "owner-1", role: "owner", version: 1, email: null, display_name: null,
                  avatar_url: null, created_at: "2026-08-30T00:00:00.000Z" }]
              : query.name === "space_deletion_schedule_v1"
                ? [{
                    space_id: "space-1", space_name: "One", owner_user_id: "owner-1",
                    requested_at: "2026-08-31T00:00:00.000Z", purge_after: "2026-09-07T00:00:00.000Z",
                    state: "scheduled", purged_rows: 0, purged_objects: 0, purge_started_at: null,
                    completed_at: null, version: 1,
                  }]
                : []);
  const result = await new PostgresSpaceControlRepository(db, "shard-0").mutateSpace({
    requestId: "request-space-delete", commandId: "command-space-delete",
    actorUserId: "owner-1", at: "2026-08-31T00:00:00.000Z",
    kind: "space_delete", spaceId: "space-1",
  });

  assert.equal(result.entityVersion, 4);
  assert.equal(result.projectionMutations[0].operation, "tombstone");
  assert.equal(result.deletion.purgeAfter, "2026-09-07T00:00:00.000Z");
  assert.deepEqual(result.recipientChanges, [
    { userId: "owner-1", visibilityScopeId: "space:space-1", change: "revoked" },
  ]);
  for (const queryName of [
    "space_deletion_members_v1", "space_deletion_membership_routes_v1",
    "space_deletion_automation_pause_v1", "space_deletion_schedule_v1",
    "space_mutation_outbox_v1", "space_control_idempotency_write_v1",
  ]) assert.equal(db.calls.some((call) => call.name === queryName), true, queryName);
  assert.equal(db.calls.some((call) => /DELETE FROM data\.spaces/u.test(call.text ?? "")), false,
    "the Space row stays until the purge");
  assert.equal(db.calls.find((call) => call.name === "space_delete_advance_v1").values[3], 3);
  const outbox = db.calls.findIndex((call) => call.name === "space_mutation_outbox_v1");
  assert.ok(outbox > db.calls.findIndex((call) => call.name === "space_deletion_schedule_v1"),
    "the outbox carries the deletion result");
});

test("member creation policy resolves its current version inside PostgreSQL", async () => {
  const db = database((query) => query.name === "space_placement_resolve_v1"
    ? [activePlacementRow()]
    : query.name === "space_member_policy_admin_v1"
      ? [{ user_id: "admin-1" }]
      : query.name === "space_member_policy_lock_v2"
        ? [{
            agent_creation_policy: "members",
            automation_creation_policy: "members", version: 2,
          }]
        : query.name === "space_member_policy_upsert_v2"
          ? [{ space_id: "space-1" }]
          : query.name === "space_member_policy_space_advance_v1"
            ? [{ version: 7 }]
            : query.name === "space_member_policy_head_v1"
              ? [{ commit_sequence: 9 }]
              : []);
  const result = await new PostgresSpaceControlRepository(db, "shard-0")
    .updateSpaceMemberCreationPolicy({
      requestId: "request-policy", commandId: "command-policy", actorUserId: "admin-1",
      at: "2026-08-31T00:00:00.000Z", spaceId: "space-1", automationCreation: "admins",
    });

  assert.equal(result.entityVersion, 3);
  assert.equal(db.calls.find((call) => call.name === "space_member_policy_upsert_v2").values[6], 2);
});

test("membership mutation updates the member directory and commits one auditable revision", async () => {
  const db = database((query) => query.name === "space_placement_resolve_v1" ||
      query.name === "user_space_membership_route_placement_fence_v1"
    ? [activePlacementRow()]
    : query.name === "space_membership_admin_v1"
      ? [{ user_id: "admin-1" }]
      : query.name === "space_membership_space_advance_v1"
        ? [{ version: 4 }]
      : query.name === "membership_head_advance_v1"
          ? [{ commit_sequence: 9 }]
          : query.name === "user_space_membership_route_source_v1"
            ? [{
                commit_sequence: 9,
                head_updated_at: "2026-08-30T00:00:00.000Z",
                role: "viewer",
                membership_version: 1,
                membership_updated_at: "2026-08-30T00:00:00.000Z",
              }]
          : []);
  const result = await new PostgresSpaceControlRepository(db, "shard-0")
    .mutateMembership({
      requestId: "request-1", commandId: "command-1", actorUserId: "admin-1",
      at: "2026-08-30T00:00:00.000Z", expectedVersion: 0,
      kind: "space_member_put", spaceId: "space-1", userId: "user-2", role: "viewer",
    });

  assert.equal(result.entityId, "space-1:user-2");
  assert.equal(result.entityVersion, 1);
  for (const queryName of [
    "space_membership_insert_v1",
    "user_space_membership_upsert_v1",
    "space_membership_space_advance_v1",
    "membership_head_advance_v1",
    "membership_outbox_v1",
    "space_control_idempotency_write_v1",
    "user_space_membership_route_publish_v1",
  ]) assert.equal(db.calls.some((call) => call.name === queryName), true, queryName);
});

test("Space invite commits its digest without publishing the bearer token to outbox", async () => {
  const db = database((query) => query.name === "space_placement_resolve_v1" ||
      query.name === "entity_space_route_placement_fence_v1"
    ? [activePlacementRow()]
    : query.name === "space_invite_space_v2"
      ? [{ name: "One", owner_user_id: "owner-1" }]
      : query.name === "space_invite_admin_v1"
        ? [{ user_id: "admin-1" }]
      : query.name === "space_invite_head_advance_v1"
          ? [{ commit_sequence: 10 }]
          : query.name === "space_invite_route_source_v1"
            ? [{
                entity_version: 1, route_version: 10,
                updated_at: "2026-08-30T00:00:00.000Z",
              }]
          : []);
  const result = await new PostgresSpaceControlRepository(db, "shard-0")
    .createSpaceInvite({
      requestId: "request-1", commandId: "command-1", spaceId: "space-1",
      actorUserId: "admin-1", role: "member", admin: false,
      maxUses: 1, requiresApproval: false,
    });

  assert.match(result.invite.token, /^[0-9a-f]{64}$/u);
  const outbox = db.calls.find((call) => call.name === "space_invite_outbox_v1");
  assert.equal(outbox.values.some((value) => String(value).includes(result.invite.token)), false);
  assert.equal(db.calls.some((call) => call.name === "space_control_idempotency_write_v1"), true);
  const route = db.calls.find((call) => call.name === "entity_space_route_publish_v1");
  assert.equal(route.values[0], "space-invite");
  assert.match(route.values[1], /^[0-9a-f]{64}$/u);
});

test("Channel creation publishes its shard-local fact into the fenced global directory", async () => {
  const placement = activePlacementRow("space-1", { shardId: "shard-1", placementEpoch: 4, planClass: "paid" });
  const db = database((query) => query.name === "space_placement_resolve_v1" ||
      query.name === "channel_space_directory_placement_fence_v1"
    ? [placement]
    : query.name === "channel_create_checks_v2"
      ? [{ role: "owner", space_id: "space-1", metadata_json: {}, channel_exists: false }]
      : query.name === "channel_create_v4"
        ? [{ channel_id: "channel-1", search_rank_sequence: "pg:00000000000000000002" }]
      : query.name === "space_control_head_advance_v1"
            ? [{ commit_sequence: 2 }]
            : []);

  const result = await new PostgresSpaceControlRepository(db, "shard-0").createChannel({
    requestId: "request-channel-1",
    commandId: "command-channel-1",
    channelId: "channel-1",
    spaceId: "space-1",
    name: "General",
    mode: "open",
    principal: { kind: "user", id: "user-1" },
  });

  assert.equal(result.id, "channel-1");
  assert.equal(result.searchRankSeq, "pg:00000000000000000002");
  const createQueries = db.calls.filter((call) => call.name?.startsWith("channel_create"));
  assert.deepEqual(createQueries.map((call) => call.name), [
    "channel_create_checks_v2", "channel_create_v4", "channel_create_outbox_v1",
  ]);
  assert.equal(db.calls.some((call) => call.name === "channel_search_rank_allocate_v1"), false);
  assert.equal(db.calls.some((call) => call.name === "channel_create_name_conflict_v1"), false);
  const inserted = db.calls.find((call) => call.name === "channel_create_v4");
  assert.match(inserted.values[3], /channel-1$/u);
  const local = db.calls.find((call) => call.name === "channel_space_directory_create_v1");
  assert.deepEqual(local.values.slice(0, 2), ["channel-1", "space-1"]);
  const global = db.calls.find((call) => call.name === "channel_space_directory_publish_v2");
  assert.ok(global);
  assert.deepEqual(JSON.parse(global.values[0]).map((value) => ({
    channelId: value.channel_id,
    shardId: value.shard_id,
    epoch: value.placement_epoch,
    version: value.entity_version,
  })), [{ channelId: "channel-1", shardId: "shard-1", epoch: 4, version: 1 }]);
});

for (const [label, granted] of [["a live Run of the owner", true], ["no live Run of the owner", false]]) {
  test(`An Agent's closed Channel grants its Instance when it is ${label}`, async () => {
    const db = database((query) => query.name === "space_placement_resolve_v1" ||
        query.name === "channel_space_directory_placement_fence_v1"
      ? [activePlacementRow("space-1", { planClass: "paid" })]
      : query.name === "channel_create_checks_v2"
        ? [{ role: "owner", space_id: "space-1", metadata_json: {}, channel_exists: false }]
      : query.name === "channel_create_v4"
        ? [{ channel_id: "channel-2", search_rank_sequence: "pg:00000000000000000003" }]
      : query.name === "channel_access_create_agent_v1" ? (granted ? [{ subject_id: "instance-1" }] : [])
      : query.name === "space_control_head_advance_v1" ? [{ commit_sequence: 3 }]
      : []);
    const create = new PostgresSpaceControlRepository(db, "shard-0").createChannel({
      requestId: "request-agent-closed", commandId: "command-agent-closed", channelId: "channel-2",
      spaceId: "space-1", name: "private work", mode: "closed",
      principal: { kind: "user", id: "owner-1" }, creatorAgentInstanceId: "instance-1",
    });
    if (!granted) {
      await assert.rejects(create, (error) => error.code === "forbidden");
      return;
    }
    await create;
    const grants = db.calls.filter((call) => call.name?.startsWith("channel_access_create"));
    assert.deepEqual(grants.map((call) => call.name), ["channel_access_create_v1", "channel_access_create_agent_v1"]);
    assert.deepEqual(grants[0].values.slice(2, 4), ["user", "owner-1"]);
    assert.deepEqual(grants[1].values.slice(0, 4), ["space-1", "channel-2", "instance-1", "owner-1"]);
    assert.match(grants[1].text, /r\.status IN \('starting','running'\)/u);
  });
}

test("Agent Space metadata rechecks the registered Instance and does not inherit owner administration", async () => {
  let present = true;
  const db = database((query) => {
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow(query.values[0], { shardId: "shard-1", placementEpoch: 4 })];
    if (query.name === "space_get_v4") {
      assert.doesNotMatch(query.text, /agent_profile/u);
      // A registered Run is authorized as its Instance.
      assert.match(query.text, /binding\.space_id = s\.space_id AND instance\.instance_id = \$2/u);
      assert.deepEqual(query.values.slice(1), ["agent-1", "agent"]);
      return present && query.values[0] === "space-1" ? [{
        space_id: "space-1", owner_user_id: "owner", name: "One",
        metadata_json: {}, created_at: "2026-08-30T00:00:00.000Z",
        updated_at: "2026-08-30T00:00:00.000Z",
      }] : [];
    }
    return [];
  });
  const repository = new PostgresSpaceControlRepository(db, "shard-0");
  const input = { requestId: "agent-space-read", spaceId: "space-1",
    principal: { kind: "agent", id: "agent-1" } };
  assert.equal((await repository.getSpace(input)).id, "space-1");
  assert.equal(db.calls.some((call) => call.name === "space_join_request_counts_hydrate_v1"), false);
  await assert.rejects(repository.getSpace({ ...input, spaceId: "private:owner" }),
    (error) => error.code === "space_not_found");
  present = false;
  await assert.rejects(repository.getSpace(input), (error) => error.code === "space_not_found");
  await assert.rejects(repository.listSpaces({ requestId: input.requestId, principal: input.principal }),
    (error) => error.code === "forbidden");
});

test("Space listing fans the global membership page into the routed physical shard", async () => {
  const db = database((query) => query.name === "user_space_membership_routes_list_v1"
    ? [{
        user_id: "user-1", space_id: "space-1", role: "owner", shard_id: "shard-1",
        placement_epoch: 4, membership_version: 1, route_version: 8,
      }]
    : query.name === "space_list_shard_v2"
      ? [{
          space_id: "space-1", owner_user_id: "user-1", name: "One",
          metadata_json: {}, created_at: "2026-08-30T00:00:00.000Z",
          updated_at: "2026-08-30T00:00:00.000Z",
        }]
    : query.name === "space_members_hydrate_v1"
      ? [{
            space_id: "space-1", user_id: "user-1", role: "owner", version: 1,
            email: null, display_name: null, avatar_url: null,
            created_at: "2026-08-30T00:00:00.000Z",
          }]
        : query.name === "space_join_request_counts_hydrate_v1"
          ? [{ space_id: "space-1", pending_join_request_count: "2" }]
        : []);
  const result = await new PostgresSpaceControlRepository(db, "shard-0").listSpaces({
    requestId: "space-list", principal: { kind: "user", id: "user-1" }, limit: 20,
  });

  assert.deepEqual(result.spaces.map((space) => space.id), ["space-1"]);
  assert.equal(result.spaces[0].pendingJoinRequestCount, 2);
  // The retired management agent left no Space configuration behind.
  assert.equal("managementAgent" in result.spaces[0], false);
  assert.equal(db.calls.some((call) => /space_management_configs/u.test(call.text ?? "")), false);
  const shardContext = db.calls.find((call) => call.context?.operation === "space.list-shard");
  assert.deepEqual(shardContext.context.placement, {
    spaceId: "space-1", shardId: "shard-1", placementEpoch: 4,
  });
  const counts = db.calls.find((call) => call.name === "space_join_request_counts_hydrate_v1");
  assert.match(counts.text, /member\.role IN \('owner','admin'\)/u);
  assert.match(counts.text, /request\.status = 'pending'/u);
  assert.deepEqual(counts.values, ["user-1", ["space-1"], 1]);
});

const at = "2026-09-11T00:00:00.000Z";
const channelRoot = {
  channel_id: "c", space_id: "s", parent_channel_id: null, name: "channel",
  mode: "open", archived_at: null, metadata_json: {}, version: 1,
  search_rank_sequence: "1", created_at: at, updated_at: at,
};
const placementRow = activePlacementRow("s", { planClass: "standard" });

const transferTestSnapshot = {
  tree: [{ ...channelRoot }],
  spaces: [{ space_id: "s", name: "Source", version: 1 }, { space_id: "target", name: "Target", version: 1 }],
  members: [{ space_id: "s", user_id: "u", role: "owner", version: 1 },
    { space_id: "target", user_id: "u", role: "owner", version: 1 }],
  access: [], targetParent: [],
};
const transferTestRef = { sourceSpaceId: "s", proposalId: "transfer-test" };
function channelMutationDatabase(respond) {
  const db = database((query) => {
    const override = respond?.(query);
    if (override !== undefined) return override;
    if (query.name === "channel_space_directory_resolve_v2") {
      return [{
        channel_id: "c", space_id: "s", shard_id: "shard-0",
        placement_epoch: 1, entity_version: 1,
      }];
    }
    if (query.name === "space_placement_resolve_v1") {
      return [{ ...placementRow, space_id: query.values[0] }];
    }
    if (query.name === "channel_mutation_root_lock_v2") return [{ ...channelRoot }];
    if (query.name === "transfer_lock_v1") return [{ space_id: "s", target_space_id: "target",
      proposal_id: "transfer-test", channel_id: "c", target_parent_id: null, status: "pending",
      outbound_user_id: "u", inbound_user_id: "u", expires_at: "2099-01-01T00:00:00Z",
      snapshot_json: transferTestSnapshot }];
    if (query.name === "transfer_spaces_v1") return transferTestSnapshot.spaces;
    if (query.name === "transfer_tree_snapshot_v3") return transferTestSnapshot.tree;
    if (query.name === "transfer_members_snapshot_v1") return transferTestSnapshot.members;
    if (query.name === "transfer_access_snapshot_v1") return [];
    if (query.name === "transfer_target_placement_fence_v1") return [{ space_id: "target" }];
    if (query.name === "channel_mutation_admin_v1" || query.name === "channel_move_target_admin_v1") {
      return [{ user_id: "u" }];
    }
    if (query.name === "channel_mutation_tree_v1") {
      return [{ ...channelRoot }];
    }
    if (query.name === "channel_archive_tree_row_v2") {
      return [{ ...channelRoot, archived_at: at, version: 2, updated_at: at }];
    }
    if (query.name === "channel_move_row_v2") return [{ channel_id: "c" }];
    if (query.name === "channel_mutation_head_advance_v1" ||
        query.name === "channel_move_target_head_advance_v1") {
      return [{ commit_sequence: 2 }];
    }
    if (query.name === "channel_mutation_recipients_v1") return [{ user_id: "u" }];
    if (query.name === "channel_space_directory_source_v1") {
      return [{ channel_id: "c", space_id: query.values?.[0]?.includes?.("target") ? "target" : "s",
        version: 2, updated_at: at }];
    }
    if (query.name === "channel_space_directory_placement_fence_v1") {
      return (query.values[0] ?? ["s"]).map((spaceId) => ({ ...placementRow, space_id: spaceId }));
    }
    return [];
  });
  return db;
}

function mutation(kind, extra = {}) {
  return {
    requestId: "request-1", commandId: `command-${kind}`, kind, channelId: "c",
    actorUserId: "u", expectedVersion: 1, at, ...extra,
  };
}

test("Cross-Space Channel moves reassign Space-scoped message facts", async () => {
  const db = channelMutationDatabase((query) => {
    if (query.name === "channel_space_directory_source_v1") {
      return [{ channel_id: "c", space_id: "target", version: 2, updated_at: at }];
    }
  });
  await new PostgresSpaceControlRepository(db, "shard-0").mutateChannel(mutation("channel_configure", {
    spaceId: "target",
  }), transferTestRef);
  for (const name of [
    "channel_move_messages_v1", "channel_move_message_reactions_v1",
    "channel_move_message_annotations_v1", "channel_move_message_mutations_v1",
    "channel_move_message_attachments_v1", "channel_move_message_attachment_refs_v1",
    "channel_move_delivery_cursors_v1", "channel_move_message_attention_v1",
    "channel_move_message_attention_revisions_v1", "channel_move_channel_content_counters_v1",
    "channel_move_channel_message_sequences_v1",
    "channel_move_agent_message_executions_v1",
    "channel_move_message_sequence_reservations_v1",
    "channel_move_reborn_intents_v1",
  ]) {
    const query = db.calls.find((call) => call.name === name);
    assert.equal(Boolean(query), true, name);
    assert.deepEqual(query.values.slice(0, 2), ["s", "target"]);
  }
  for (const name of [
    "channel_move_pause_automations_v1", "channel_move_expire_trace_access_v1",
    "channel_move_remove_app_relations_v1", "channel_move_fail_reborn_v1",
  ]) {
    const query = db.calls.find((call) => call.name === name);
    assert.equal(Boolean(query), true, name);
    assert.deepEqual(query.values[0], ["c"], name);
  }
  assert.equal(db.calls.some((call) => call.name === "channel_move_tree_v1"), false,
    "a conversation moves alone; no tree is loaded");
  const blockers = db.calls.find((call) => call.name === "channel_move_blockers_v3");
  assert.doesNotMatch(blockers.text, /data\.message_attachment/u);
});

test("Cross-Space Channel moves identify the remaining blocker", async () => {
  const db = channelMutationDatabase((query) => {
    if (query.name === "channel_move_blockers_v3") {
      return [{ blocker_kind: "live instance" }];
    }
  });
  await assert.rejects(
    new PostgresSpaceControlRepository(db, "shard-0").mutateChannel(mutation("channel_configure", {
      spaceId: "target",
    }), transferTestRef),
    (error) => error instanceof SpaceControlError && error.status === 409 &&
      error.message === "resolve live instance before moving",
  );
});

test("Cross-Space Channel moves reject a stale explicit tree snapshot", async () => {
  const db = channelMutationDatabase();
  await assert.rejects(
    new PostgresSpaceControlRepository(db, "shard-0").mutateChannel(mutation("channel_configure", {
      spaceId: "target",
      moveTree: [{ channelId: "c", expectedVersion: 2 }],
    }), transferTestRef),
    (error) => error instanceof SpaceControlError && error.code === "conflict" &&
      /tree changed while move was prepared/u.test(error.message),
  );
});

test("real adapter rejects a Channel tree query that still declares 10001 rows", async () => {
  await assert.rejects(
    createAuthorityDatabase({
      connectionString: "postgres://unused/audit",
      shardId: "shard-0",
      clientFactory: () => ({
        async connect() {},
        async end() {},
        async query() { return { rows: [], rowCount: 0 }; },
      }),
    }).transaction({
      requestId: "r", operation: "channel.audit",
    }, (transaction) => transaction.query({
      name: "channel_mutation_tree_legacy_v1",
      text: "SELECT 1",
      maxRows: 10_001,
    })),
    (error) => error instanceof DatabaseContractError &&
      /query.maxRows must be between 0 and 10000/u.test(error.message),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { PostgresUserSpaceMembershipDirectory } from "../dist/index.js";
import { recordingDatabase as database } from "./recording-database.fixture.mjs";

test("membership directory merges versioned global routes with the legacy rollout source", async () => {
  const source = database((query) => query.name === "user_space_membership_routes_list_v1" ? [{
    user_id: "user-1",
    space_id: "space-1",
    role: "owner",
    shard_id: "shard-1",
    placement_epoch: "4",
    membership_version: "2",
    route_version: "12",
  }] : []);
  const routes = await new PostgresUserSpaceMembershipDirectory(source).list({
    requestId: "membership-list", operation: "space.list-directory",
  }, "user-1", "", 10);

  assert.deepEqual(routes, [{
    userId: "user-1", spaceId: "space-1", role: "owner", shardId: "shard-1",
    placementEpoch: 4, membershipVersion: 2, routeVersion: 12,
  }]);
  assert.match(source.calls[1].text, /user_space_membership_routes/u);
  assert.match(source.calls[1].text, /user_space_memberships/u);
});

test("membership directory fences publication and orders remove/rejoin by Space commit sequence", async () => {
  const source = database((query) =>
    query.name === "user_space_membership_route_placement_fence_v1"
      ? [{ space_id: "space-1", shard_id: "shard-1", placement_epoch: 4 }]
      : []);
  await new PostgresUserSpaceMembershipDirectory(source).publish({
    requestId: "membership-publish", operation: "membership.directory-publish",
  }, {
    userId: "user-1", spaceId: "space-1", role: "member", shardId: "shard-1",
    placementEpoch: 4, membershipVersion: 1, routeVersion: 19, state: "active",
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  });

  const publication = source.calls.find((call) =>
    call.name === "user_space_membership_route_publish_v1");
  assert.deepEqual(publication.values.slice(0, 8), [
    "user-1", "space-1", "member", "shard-1", 4, 1, 19, "active",
  ]);
  assert.equal(publication.values[8], "2026-08-30T00:00:00.000Z");
  assert.match(publication.text, /EXCLUDED\.route_version/u);
});

test("membership directory rejects an old physical placement", async () => {
  const source = database((query) =>
    query.name === "user_space_membership_route_placement_fence_v1"
      ? [{ space_id: "space-1", shard_id: "shard-2", placement_epoch: 5 }]
      : []);
  await assert.rejects(new PostgresUserSpaceMembershipDirectory(source).publish({
    requestId: "membership-stale", operation: "membership.directory-publish",
  }, {
    userId: "user-1", spaceId: "space-1", role: "member", shardId: "shard-1",
    placementEpoch: 4, membershipVersion: 1, routeVersion: 19, state: "active",
    updatedAt: "2026-08-30T00:00:00.000Z",
  }), /publication is stale/u);
  assert.equal(source.calls.some((call) =>
    call.name === "user_space_membership_route_publish_v1"), false);
});

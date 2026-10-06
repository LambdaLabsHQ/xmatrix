import assert from "node:assert/strict";
import test from "node:test";

import { PostgresEntitySpaceDirectory } from "../dist/index.js";
import { recordingDatabase as database } from "./recording-database.fixture.mjs";

test("entity directory resolves only an exact current placement route", async () => {
  const source = database((query) => query.name === "entity_space_route_resolve_v1" ? [{
    entity_kind: "space-invite", entity_id: "token-hash", space_id: "space-1",
    shard_id: "shard-1", placement_epoch: 4, entity_version: 2, route_version: 19,
  }] : []);
  assert.deepEqual(await new PostgresEntitySpaceDirectory(source).resolve({
    requestId: "entity-resolve", operation: "space-invite.locate",
  }, "space-invite", "token-hash"), {
    kind: "space-invite", entityId: "token-hash", spaceId: "space-1",
    shardId: "shard-1", placementEpoch: 4, entityVersion: 2, routeVersion: 19,
  });
  assert.match(source.calls[1].text, /placement\.placement_epoch = route\.placement_epoch/u);
  assert.match(source.calls[1].text, /placement\.state = 'active'/u);
});

test("entity directory publishes through placement and route-version fences", async () => {
  const source = database((query) => query.name === "entity_space_route_placement_fence_v1"
    ? [{ shard_id: "shard-1", placement_epoch: 4 }] : []);
  await new PostgresEntitySpaceDirectory(source).publish({
    requestId: "entity-publish", operation: "space-invite.directory-publish",
  }, {
    kind: "space-invite", entityId: "token-hash", spaceId: "space-1",
    shardId: "shard-1", placementEpoch: 4, entityVersion: 2, routeVersion: 19,
    state: "active", updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
  const publication = source.calls.find((call) => call.name === "entity_space_route_publish_v1");
  assert.deepEqual(publication.values.slice(0, 8), [
    "space-invite", "token-hash", "space-1", "shard-1", 4, 2, 19, "active",
  ]);
  assert.match(publication.text, /EXCLUDED\.route_version/u);
  assert.match(publication.text, /EXCLUDED\.entity_version >=/u);
  assert.equal(publication.values[8], "2026-08-30T00:00:00.000Z");
});

test("entity directory rejects unsupported kinds and stale placements", async () => {
  const source = database((query) => query.name === "entity_space_route_placement_fence_v1"
    ? [{ shard_id: "shard-2", placement_epoch: 5 }] : []);
  const directory = new PostgresEntitySpaceDirectory(source);
  await assert.rejects(directory.resolve({
    requestId: "unsupported", operation: "entity.resolve",
  }, "unknown", "entity-1"), /kind is unsupported/u);
  await assert.rejects(directory.publish({
    requestId: "stale", operation: "space-invite.directory-publish",
  }, {
    kind: "space-invite", entityId: "token-hash", spaceId: "space-1",
    shardId: "shard-1", placementEpoch: 4, entityVersion: 2, routeVersion: 19,
    state: "active", updatedAt: "2026-08-30T00:00:00.000Z",
  }), /publication is stale/u);
});

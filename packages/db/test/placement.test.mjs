import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseContractError,
  PostgresChannelSpaceDirectory,
  PostgresSpacePlacementDirectory,
} from "../dist/index.js";
import { activePlacementRow, recordingDatabase } from "./recording-database.fixture.mjs";

function database(rows, cacheMode = "disabled") {
  return recordingDatabase(() => rows, { cacheMode });
}

function placementPublisher(respond) {
  const source = database([]);
  source.transaction = async (context, callback) => {
    source.calls.push({ context });
    return callback({ async query(query) { source.calls.push(query); return respond(query); } });
  };
  return source;
}

test("placement directory returns the exact shard epoch through correctness storage", async () => {
  const source = database([{
    space_id: "space-1",
    shard_id: "shard-0",
    placement_epoch: "3",
    state: "active",
    target_shard_id: null,
    plan_class: "free",
  }]);
  const directory = new PostgresSpacePlacementDirectory(source);
  assert.deepEqual(await directory.resolve({
    requestId: "placement-request", operation: "space-placement.resolve",
  }, "space-1"), {
    spaceId: "space-1",
    shardId: "shard-0",
    placementEpoch: 3,
    state: "active",
    targetShardId: null,
    planClass: "free",
  });
  assert.equal(source.calls[0].context.placement, undefined);
  assert.equal(source.calls[1].name, "space_placement_resolve_v1");
  assert.equal(source.calls[1].maxRows, 1);
});

test("placement directory fails closed on absent, malformed, or cached routes", async () => {
  await assert.rejects(
    new PostgresSpacePlacementDirectory(database([])).resolve({
      requestId: "placement-request", operation: "space-placement.resolve",
    }, "space-1"),
    /placement is unavailable/u,
  );
  await assert.rejects(
    new PostgresSpacePlacementDirectory(database([activePlacementRow("space-1", { placementEpoch: 0, planClass: "free" })])).resolve({
      requestId: "placement-request", operation: "space-placement.resolve",
    }, "space-1"),
    /placement row is invalid/u,
  );
  assert.throws(
    () => new PostgresSpacePlacementDirectory(database([], "cached")),
    DatabaseContractError,
  );
});

test("Channel directory resolves a global route with its placement and entity fences", async () => {
  const source = database([{
    channel_id: "channel-1",
    space_id: "space-1",
    shard_id: "shard-1",
    placement_epoch: "4",
    entity_version: "9",
  }]);
  const directory = new PostgresChannelSpaceDirectory(source);

  assert.deepEqual(await directory.resolve({
    requestId: "channel-route", operation: "channel.resolve-space",
  }, "channel-1"), {
    channelId: "channel-1",
    spaceId: "space-1",
    shardId: "shard-1",
    placementEpoch: 4,
    entityVersion: 9,
  });
  assert.equal(source.calls[1].name, "channel_space_directory_resolve_v2");
  assert.match(source.calls[1].text, /channel_space_routes/u);
  assert.match(source.calls[1].text, /channel_space_directory/u);
});

test("Channel directory publishes a versioned batch only through the current placement", async () => {
  const source = placementPublisher(query => query.name === "channel_space_directory_placement_fence_v1" ? [activePlacementRow("space-1", { shardId: "shard-1", placementEpoch: 4, planClass: "paid" })] : []);
  const directory = new PostgresChannelSpaceDirectory(source);
  await directory.publishMany({
    requestId: "channel-publish", operation: "channel.directory-publish",
  }, [{
    channelId: "channel-1", spaceId: "space-1", shardId: "shard-1",
    placementEpoch: 4, entityVersion: 7, state: "active",
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  }, {
    channelId: "channel-2", spaceId: "space-1", shardId: "shard-1",
    placementEpoch: 4, entityVersion: 3, state: "deleted",
    updatedAt: "2026-08-30T00:00:00.000Z",
  }]);

  const publication = source.calls.find((call) => call.name === "channel_space_directory_publish_v2");
  const payload = JSON.parse(publication.values[0]);
  assert.deepEqual(payload.map((value) => [value.channel_id, value.state]), [
    ["channel-1", "active"], ["channel-2", "deleted"],
  ]);
  assert.deepEqual(payload.map((value) => value.updated_at), [
    "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z",
  ]);
  assert.match(publication.text, /EXCLUDED\.placement_epoch/u);
  assert.match(publication.text, /EXCLUDED\.entity_version/u);
});

test("Channel directory rejects a delayed publisher from an old shard epoch", async () => {
  const source = database([]);
  source.transaction = async function transaction(context, callback) {
    this.calls.push({ context });
    return callback({ query: async (query) => {
      this.calls.push(query);
      return [activePlacementRow("space-1", { shardId: "shard-2", placementEpoch: 5, planClass: "paid" })];
    } });
  };
  await assert.rejects(new PostgresChannelSpaceDirectory(source).publish({
    requestId: "stale-publish", operation: "channel.directory-publish",
  }, {
    channelId: "channel-1", spaceId: "space-1", shardId: "shard-1",
    placementEpoch: 4, entityVersion: 7, state: "active",
    updatedAt: "2026-08-30T00:00:00.000Z",
  }), /publication is stale/u);
  assert.equal(source.calls.some((call) => call.name === "channel_space_directory_publish_v2"), false);
});

test("Channel directory resolves a route and its Space's current placement in one single read", async () => {
  const row = {
    channel_id: "channel-1", space_id: "space-1", shard_id: "shard-0", placement_epoch: "2",
    entity_version: "4", placement_space_id: "space-1", placement_shard_id: "shard-1",
    placement_placement_epoch: "3", placement_state: "moving", placement_target_shard_id: "shard-2",
    placement_plan_class: "free",
  };
  const source = database([row]);
  const context = { requestId: "route-request", operation: "channel.resolve-space" };
  assert.deepEqual(await new PostgresChannelSpaceDirectory(source).resolveWithPlacement(context, "channel-1"), {
    route: { channelId: "channel-1", spaceId: "space-1", shardId: "shard-0", placementEpoch: 2, entityVersion: 4 },
    // The placement is the directory's current row, not the route's copy of it.
    placement: { spaceId: "space-1", shardId: "shard-1", placementEpoch: 3, state: "moving",
      targetShardId: "shard-2", planClass: "free" },
  });
  assert.equal(source.calls[0].context.statement, "single_read");
  assert.equal(source.calls[0].context.placement, undefined);
  assert.equal(source.calls.filter((call) => call.name).length, 1);
  assert.equal(source.calls[1].name, "channel_space_directory_resolve_placed_v1");
  assert.match(source.calls[1].text,
    /LEFT JOIN control\.space_placement placement ON placement\.space_id = route\.space_id/u);

  assert.equal(await new PostgresChannelSpaceDirectory(database([])).resolveWithPlacement(context, "channel-1"), null);
  assert.equal((await new PostgresChannelSpaceDirectory(database([{ ...row, placement_space_id: null }]))
    .resolveWithPlacement(context, "channel-1")).placement, null);
  await assert.rejects(new PostgresChannelSpaceDirectory(database([{ ...row, channel_id: "other" }]))
    .resolveWithPlacement(context, "channel-1"), DatabaseContractError);
  await assert.rejects(new PostgresChannelSpaceDirectory(database([{ ...row, placement_state: "unknown" }]))
    .resolveWithPlacement(context, "channel-1"), DatabaseContractError);
});

test("Channel directory resolves many routes in one single read and omits unrouted Channels", async () => {
  const route = (channelId, spaceId) => ({ channel_id: channelId, space_id: spaceId, shard_id: "shard-0",
    placement_epoch: "2", entity_version: "1" });
  const source = database([route("channel-1", "space-1"), route("channel-3", "space-2")]);
  const directory = new PostgresChannelSpaceDirectory(source);
  const context = { requestId: "routes", operation: "channel.resolve-spaces" };
  const routes = await directory.resolveMany(context, ["channel-1", "channel-2", "channel-3", "channel-1"]);
  assert.deepEqual([...routes].map(([id, value]) => [id, value.spaceId]),
    [["channel-1", "space-1"], ["channel-3", "space-2"]]);
  assert.equal(source.calls[0].context.statement, "single_read");
  assert.deepEqual(source.calls[1].values, [["channel-1", "channel-2", "channel-3"]]);
  assert.equal(source.calls[1].maxRows, 3);
  assert.deepEqual(await directory.resolveMany(context, []), new Map());

  const foreign = new PostgresChannelSpaceDirectory(database([route("channel-9", "space-9")]));
  await assert.rejects(foreign.resolveMany(context, ["channel-1"]), /directory identity differs/u);
  await assert.rejects(directory.resolveMany(context,
    Array.from({ length: 513 }, (_, index) => `channel-${index}`)), /read is too large/u);
});

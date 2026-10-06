import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresAuthorityFleet,
} from "../src/postgres-authority-fleet.ts";

function fakeDatabase(options, calls) {
  calls.push(options);
  return {
    cacheMode: "disabled",
    async transaction(context, callback) {
      return callback({ query: async () => [{ selected: options.shardId, context }] });
    },
    async health() {
      return { status: "ready", shardId: options.shardId };
    },
  };
}

test("authority fleet routes placed work over an explicit finite binding set", async () => {
  const calls = [];
  const fleet = createPostgresAuthorityFleet({
    RELAY_POSTGRES: { connectionString: "postgres://directory" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://shard-1" },
    RELAY_POSTGRES_SHARD_1_ID: "shard-1",
  }, { applicationName: "fleet-test" }, {
    createDatabase: (options) => fakeDatabase(options, calls),
  });

  assert.equal(fleet.defaultShardId, "shard-0");
  assert.deepEqual(fleet.physicalShards.map(({ shardId }) => shardId), ["shard-0", "shard-1"]);
  assert.deepEqual(calls.map(({ connectionString, shardId }) => ({ connectionString, shardId })), [
    { connectionString: "postgres://directory", shardId: "shard-0" },
    { connectionString: "postgres://shard-1", shardId: "shard-1" },
  ]);
  const result = await fleet.database.transaction({
    requestId: "request-1",
    operation: "fleet.route",
    placement: { spaceId: "space-1", shardId: "shard-1", placementEpoch: 2 },
  }, async (transaction) => transaction.query({
    name: "fleet_route_test_v1", text: "SELECT 1", maxRows: 1,
  }));
  assert.equal(result[0].selected, "shard-1");
});

test("authority fleet rejects partial and duplicate shard bindings", () => {
  const createDatabase = (options) => fakeDatabase(options, []);
  assert.throws(() => createPostgresAuthorityFleet({
    RELAY_POSTGRES: { connectionString: "postgres://directory" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://shard-1" },
  }, {}, { createDatabase }), /must be configured together/u);
  assert.throws(() => createPostgresAuthorityFleet({
    RELAY_POSTGRES: { connectionString: "postgres://directory" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://duplicate" },
    RELAY_POSTGRES_SHARD_1_ID: "shard-0",
  }, {}, { createDatabase }), /duplicated/u);
});

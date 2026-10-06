import assert from "node:assert/strict";
import test from "node:test";

import { userPreferenceDatabaseContext } from "../src/user-preference-postgres-authority.ts";

const placement = {
  spaceId: "space-1",
  shardId: "shard-0",
  placementEpoch: 3,
  state: "active",
  targetShardId: null,
  planClass: "free",
};

test("PostgreSQL preference authority rejects moving routes", () => {
  assert.throws(
    () => userPreferenceDatabaseContext("request-1", "preference.read", {
      ...placement, state: "moving", targetShardId: "shard-1",
    }),
    /access is fenced/u,
  );
  assert.throws(
    () => userPreferenceDatabaseContext("request-1", "preference.read", {
      ...placement, targetShardId: "shard-1",
    }),
    /access is fenced/u,
  );
  assert.deepEqual(
    userPreferenceDatabaseContext("request-1", "preference.read", placement),
    {
      requestId: "request-1",
      operation: "preference.read",
      placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 3 },
    },
  );
});

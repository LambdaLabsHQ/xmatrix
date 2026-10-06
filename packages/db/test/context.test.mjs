import assert from "node:assert/strict";
import test from "node:test";

import {
  databaseRequestContext,
  InvalidDatabaseContextError,
} from "../dist/context.js";

test("database context normalizes and freezes a complete placement", () => {
  const context = databaseRequestContext({
    requestId: " request-1 ",
    operation: " channel.message.append ",
    placement: {
      spaceId: " space-1 ",
      shardId: " shard-0 ",
      placementEpoch: 3,
    },
  });
  assert.deepEqual(context, {
    requestId: "request-1",
    operation: "channel.message.append",
    placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 3 },
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.placement), true);
});

test("database context rejects partial or unbounded identity", () => {
  assert.throws(
    () => databaseRequestContext({ requestId: "", operation: "read" }),
    InvalidDatabaseContextError,
  );
  assert.throws(
    () => databaseRequestContext({
      requestId: "request-1",
      operation: "read",
      placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 0 },
    }),
    /placementEpoch/u,
  );
});

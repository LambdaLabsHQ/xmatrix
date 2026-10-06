import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizedTraceChannelIds,
  traceAuthorizationChecksForChannels,
} from "../src/trace-authorization-batch.ts";

test("trace authorization batches deduplicate history Channels", () => {
  assert.deepEqual(traceAuthorizationChecksForChannels("user:a", ["channel:1", "channel:2", "channel:1"]), [
    { userId: "user:a", channelId: "channel:1" },
    { userId: "user:a", channelId: "channel:2" },
  ]);
});

test("trace authorization response parsing is exact and fail closed", () => {
  assert.deepEqual(
    [...authorizedTraceChannelIds({
      instanceId: "instance:1",
      decisions: [
        { userId: "user:a", channelId: "channel:1", allowed: false },
        { userId: "user:a", channelId: "channel:2", allowed: true },
      ],
    }, "instance:1", "user:a", ["channel:1", "channel:2"])],
    ["channel:2"],
  );
});

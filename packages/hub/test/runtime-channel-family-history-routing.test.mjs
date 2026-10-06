import assert from "node:assert/strict";

import { test } from "node:test";

import { channelHistoryAs } from "../src/runtime-transport/runtime-messages.ts";

function poisonedRetiredNamespace() {
  return { idFromName() { assert.fail("history addressed a retired DO namespace"); }, get() { assert.fail("history opened a retired DO namespace"); } };
}

function postgresEnv(extra = {}) {
  return {
    RELAY_CHANNEL_FAMILY_DIRECTORY: poisonedRetiredNamespace(),
    RELAY_CHANNEL_FAMILY_DATA: poisonedRetiredNamespace(),
    ...extra,
  };
}

test("Runtime history fails closed without a PG binding and never reads a retired family", async () => {
  await assert.rejects(channelHistoryAs(postgresEnv(), {
    channelId: "channel-1", limit: 10, principal: { kind: "user", id: "user-1" },
  }), /PostgreSQL rejected channel-history/u);
});


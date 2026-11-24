import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchRestingInstanceWake,
  productMessageWakesRestingInstances,
} from "../src/product-message-post-commit.ts";

test("any conversation message wakes resting Instances, but lifecycle controls own their targets", () => {
  for (const body of ["hello", "@claude:3 can you check?", "/goal ship it"]) {
    assert.equal(productMessageWakesRestingInstances(body), true, body);
  }
  for (const body of ["/kill all", "@helper:1 /model test", "@claude:3:stop", "@claude:3:reborn continue", "@claude:3:handoff:@codex go"]) {
    assert.equal(productMessageWakesRestingInstances(body), false, body);
  }
});

test("Auto launches do not wake sleeping observers with a second copy of the assignment", () => {
  for (const body of [
    "@auto repo:owner/repo audit the batch",
    "@auto harness:claude check the release",
    "@claude repo:owner/repo fix it",
  ]) {
    assert.equal(productMessageWakesRestingInstances(body), false, body);
  }
  for (const body of ["continue the review", "@codex:117 continue", "`@auto repo:owner/repo`", "> @auto review"]) {
    assert.equal(productMessageWakesRestingInstances(body), true, body);
  }
});

test("a committed message prepares its Channel's wakes under one command per message", async () => {
  const calls = [];
  const env = {};
  await dispatchRestingInstanceWake({ env, channelId: "channel-1", messageId: "message-1", body: "hello",
    actorUserId: "user-1", senderKind: "user", senderId: "user-1" }, async (wakeEnv, request) => {
    calls.push({ wakeEnv, request });
    return { woken: [], refused: [] };
  });
  assert.equal(calls[0].wakeEnv, env);
  assert.deepEqual(calls[0].request, { commandId: "resting-wake:message-1", channelId: "channel-1",
    sourceMessageId: "message-1", prompt: "hello" });
  await assert.rejects(dispatchRestingInstanceWake({ env, channelId: "channel-1", messageId: "message-2",
    body: "hello", actorUserId: "user-1", senderKind: "user", senderId: "user-1" },
  async () => { throw new Error("Resting Instance wake failed"); }), /Resting Instance wake failed/u);
});

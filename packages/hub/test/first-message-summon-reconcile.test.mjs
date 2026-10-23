import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileFirstMessageSummons } from "../src/first-message-summon-reconcile.ts";

/** A shard whose due read returns `due`; the read itself is covered against PostgreSQL. */
const shard = due => ({ transaction: async () => due });

// The request that sent a new conversation's first message ran its decision
// and summon in a background budget that ended first (2026-10-17: the summon
// appended 27s in, and its launch was cut off at 30s with nothing retrying it).
test("a first message whose summon its request never finished is finished by its Channel's coordinator", async () => {
  const calls = [];
  const ports = {
    summon: async input => { calls.push(["summon", input.messageId, input.harness, input.actorUserId]); },
    start: async input => { calls.push(["start", input.messageId, input.body, input.senderKind, input.actorUserId]); },
    readBody: async (_env, input) => input.messageId === "gone" ? undefined
      : { body: "how is our iOS review going", authorKind: "user" },
  };
  await reconcileFirstMessageSummons({}, shard([
    { messageId: "decided", authorUserId: "author", harness: "claude" },
    { messageId: "undecided", authorUserId: "author" },
    { messageId: "gone", authorUserId: "author" },
  ]), "channel", ports);
  assert.deepEqual(calls, [
    ["summon", "decided", "claude", "author"],
    ["start", "undecided", "how is our iOS review going", "user", "author"],
  ], "a decided harness is summoned as the author; an undecided message is decided again from its own body");
});

test("one first message that cannot be summoned does not hold back the rest", async () => {
  const summoned = [];
  await reconcileFirstMessageSummons({}, shard([
    { messageId: "refused", authorUserId: "author", harness: "codex" },
    { messageId: "next", authorUserId: "author", harness: "claude" },
  ]), "channel", {
    summon: async input => {
      if (input.messageId === "refused") throw new Error("coordinator unavailable");
      summoned.push(input.messageId);
    },
    start: async () => assert.fail("nothing is undecided"),
    readBody: async () => assert.fail("nothing is undecided"),
  });
  assert.deepEqual(summoned, ["next"]);
});

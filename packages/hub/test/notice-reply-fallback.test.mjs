import assert from "node:assert/strict";
import { test } from "node:test";
import { appendNoticeWithReplyFallback } from "../src/runtime-transport/notice-reply-fallback.ts";
import { RuntimeAuthorityOperationError } from "../src/runtime-transport/runtime-operation-failure.ts";

test("a notice whose reply target is gone lands once without the reply", async () => {
  const gone = new RuntimeAuthorityOperationError("append-message", 400,
    { code: "invalid_reply_target" }, true);
  assert.equal(gone.authorityCode, "invalid_reply_target");
  const calls = [];
  const result = await appendNoticeWithReplyFallback(async (replyToMessageId) => {
    calls.push(replyToMessageId);
    if (replyToMessageId === "message-1") throw gone;
    return "posted";
  }, "message-1",
    error => error instanceof RuntimeAuthorityOperationError && error.authorityCode === "invalid_reply_target");
  assert.equal(result, "posted");
  assert.deepEqual(calls, ["message-1", undefined]);
});

test("another rejection still fails the notice and is not appended twice", async () => {
  const other = new RuntimeAuthorityOperationError("append-message", 503, { code: "overloaded" }, true);
  const calls = [];
  await assert.rejects(appendNoticeWithReplyFallback(async () => {
    calls.push("attempt");
    throw other;
  }, "message-1", () => false), error => error === other);
  assert.equal(calls.length, 1);
});

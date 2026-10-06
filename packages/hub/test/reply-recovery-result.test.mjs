import assert from "node:assert/strict";
import test from "node:test";
import {
  safeReplyRecoveryResult,
} from "../src/reply-recovery-result.ts";
test("recovery results expose references, never Machine credentials or saved content", () => {
  assert.deepEqual(safeReplyRecoveryResult({ status: "committed", messageId: "message", executionKey: "PRIVATE", body: "PRIVATE" }),
    { status: "committed", messageId: "message" });
  assert.deepEqual(safeReplyRecoveryResult({ status: "selection_required", candidates: [
    { messageId: "one", createdAt: 123, body: "PRIVATE" }, { messageId: "two", createdAt: 124, token: "PRIVATE" }] }),
    { status: "selection_required", candidates: [{ messageId: "one", createdAt: 123 }, { messageId: "two", createdAt: 124 }] });
  for (const value of [null, [], { status: "committed" }, { status: "unavailable", code: "PRIVATE" },
    { status: "selection_required", candidates: [{ messageId: "one", createdAt: -1 }] }]) {
    assert.deepEqual(safeReplyRecoveryResult(value), { status: "unavailable", code: "reply_recovery_failed" });
  }
});

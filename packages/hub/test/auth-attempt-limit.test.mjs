import assert from "node:assert/strict";
import test from "node:test";

import { ATTEMPT_WINDOW_MS, chargeAttempt } from "../src/auth-attempt-limit.ts";

test("an attempt is admitted while every counter has room and charged to all of them", () => {
  const limits = [{ key: "client", max: 3 }, { key: "email", max: 1 }];
  const first = chargeAttempt([[], []], limits, 1_000);
  assert.deepEqual(first, { admitted: true, next: [[1_000], [1_000]] });
  const second = chargeAttempt(first.next, limits, 2_000);
  assert.equal(second.admitted, false, "the spent email counter refuses even though the client has room");
  assert.deepEqual(second.next, first.next, "a refused attempt is charged to no counter");
});

test("attempts older than the window no longer count", () => {
  const limits = [{ key: "client", max: 1 }];
  assert.equal(chargeAttempt([[1_000]], limits, 1_000 + ATTEMPT_WINDOW_MS - 1).admitted, false);
  assert.deepEqual(chargeAttempt([[1_000]], limits, 1_000 + ATTEMPT_WINDOW_MS),
    { admitted: true, next: [[1_000 + ATTEMPT_WINDOW_MS]] });
});

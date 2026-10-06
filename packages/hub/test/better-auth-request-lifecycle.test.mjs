import assert from "node:assert/strict";
import test from "node:test";

import {
  runBetterAuthHandlerWithObservedHookFailure,
} from "../src/better-auth-request-lifecycle.ts";

test("Better Auth cannot report 200 after its OTP hook failed", async () => {
  const deliveryError = new Error("email provider unavailable");
  await assert.rejects(
    runBetterAuthHandlerWithObservedHookFailure(
      async () => Response.json({ success: true }),
      () => deliveryError,
    ),
    deliveryError,
  );
});

test("Better Auth preserves a successful response when the OTP hook succeeded", async () => {
  const response = await runBetterAuthHandlerWithObservedHookFailure(
    async () => Response.json({ success: true }),
    () => undefined,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
});

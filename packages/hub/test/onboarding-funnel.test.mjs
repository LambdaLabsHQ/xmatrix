import assert from "node:assert/strict";
import test from "node:test";
import { onboardingStepDataPoint } from "../src/index-routes-onboarding-funnel.ts";

test("a counted step carries the person's keyed hash and the step, where and on what, nothing else", async () => {
  const point = await onboardingStepDataPoint({ step: "command_copied", surface: "welcome", device: "phone" }, "user-1", "key");
  assert.match(point.indexes[0], /^[0-9a-f]{16}$/u);
  assert.notEqual(point.indexes[0], "user-1");
  assert.deepEqual(point.blobs.slice(0, 5), ["onboarding", "phone", "onboarding_step", "command_copied", "welcome"]);
  // No agent, Space, conversation or run rides along.
  assert.deepEqual(point.blobs.slice(5), ["unknown", "unknown", "unknown", "unknown", "unknown"]);
  const starter = await onboardingStepDataPoint({ step: "starter_chosen", surface: "welcome", device: "desktop_app", starter: "plan" },
    "user-1", "key");
  assert.equal(starter.blobs[3], "starter_chosen:plan");
  assert.equal(starter.indexes[0], point.indexes[0], "one person is one hash");
});

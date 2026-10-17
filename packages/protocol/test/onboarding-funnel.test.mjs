import assert from "node:assert/strict";
import { test } from "node:test";
import { ONBOARDING_FUNNEL_STEPS, parseOnboardingFunnelEvent } from "../dist/index.js";

test("an onboarding step is only a step, where it was shown, on what, and a first task's id", () => {
  for (const step of ONBOARDING_FUNNEL_STEPS.filter((item) => item !== "starter_chosen")) {
    assert.deepEqual(parseOnboardingFunnelEvent({ step, surface: "space", device: "phone" }), { step, surface: "space", device: "phone" });
  }
  assert.deepEqual(parseOnboardingFunnelEvent({ step: "app_loaded", surface: "shell", device: "desktop_web" }),
    { step: "app_loaded", surface: "shell", device: "desktop_web" });
  assert.deepEqual(parseOnboardingFunnelEvent({ step: "starter_chosen", surface: "welcome", device: "desktop_app", starter: "xmatrix" }),
    { step: "starter_chosen", surface: "welcome", device: "desktop_app", starter: "xmatrix" });
  for (const invalid of [
    undefined, null, [], "command_shown",
    { step: "page_viewed", surface: "welcome", device: "phone" },
    { step: "command_shown", surface: "settings", device: "phone" },
    { step: "command_shown", surface: "welcome", device: "tablet" },
    // A first task names which one, and nothing else does.
    { step: "starter_chosen", surface: "welcome", device: "phone" },
    { step: "starter_chosen", surface: "welcome", device: "phone", starter: "anything" },
    { step: "command_copied", surface: "welcome", device: "phone", starter: "plan" },
    // Nothing that could identify the person rides along.
    { step: "command_shown", surface: "welcome", device: "phone", email: "ada@example.com" },
  ]) assert.equal(parseOnboardingFunnelEvent(invalid), undefined, JSON.stringify(invalid));
});

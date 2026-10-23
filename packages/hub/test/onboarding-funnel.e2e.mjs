import { test } from "node:test";
import assert from "node:assert/strict";
import { withOwnerWorker } from "./owner-worker.mjs";

const step = (call, body) => call("/api/observable/onboarding-step", { method: "POST", body });

test("a signed-in person's onboarding step is counted; anything else is refused", () =>
  withOwnerWorker("Ada Lovelace", async ({ call }) => {
    assert.equal((await step(call, { step: "command_shown", surface: "welcome", device: "desktop_web" })).status, 204);
    assert.equal((await step(call, { step: "starter_chosen", surface: "welcome", device: "phone", starter: "project" })).status, 204);
    for (const invalid of [
      { step: "page_viewed", surface: "welcome", device: "desktop_web" },
      { step: "command_shown", surface: "welcome", device: "desktop_web", starter: "project" },
      { step: "starter_chosen", surface: "welcome", device: "desktop_web" },
      { step: "command_shown", surface: "welcome", device: "desktop_web", email: "ada@example.com" },
    ]) {
      const refused = await step(call, invalid);
      assert.equal(refused.status, 400, JSON.stringify(invalid));
      assert.equal(refused.body.code, "invalid_onboarding_step");
    }
  }));

const daemonFailure = (call, body) => call("/api/observable/desktop-daemon-failure", { method: "POST", body });

test("a signed-in person's failed daemon start is written; anything else is refused", () =>
  withOwnerWorker("Ada Lovelace", async ({ call }) => {
    const report = { stage: "exit", exitCode: 1, detail: "Permission denied", platform: "darwin", appVersion: "1.0.540" };
    assert.equal((await daemonFailure(call, report)).status, 204);
    for (const invalid of [
      { ...report, stage: "page_viewed" },
      { ...report, exitCode: 1.5 },
      { ...report, appVersion: undefined },
      { ...report, email: "ada@example.com" },
    ]) {
      const refused = await daemonFailure(call, invalid);
      assert.equal(refused.status, 400, JSON.stringify(invalid));
      assert.equal(refused.body.code, "invalid_daemon_failure");
    }
  }));

const assert = require("node:assert/strict");
const test = require("node:test");

require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { capturedDiagnosticPosts } = require("./diagnostic-posts-test-capture.cjs");
const { recordOnboardingStep } = require("./onboarding-funnel.ts");
const { markStartup, reportStartupTiming } = require("./startup-timing.ts");

// Privacy contract (docs/guide/privacy.md): the browser sends an onboarding
// step or an app start only as its declared fields. Text a person wrote,
// handed to either send point in a field or beside one, never leaves.
const SENTINEL = "SENTINEL private message body /Users/ada/notes";
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an onboarding step leaves as its declared fields; message text in or beside them is not sent", async (t) => {
  const sent = capturedDiagnosticPosts(t);
  recordOnboardingStep("token", { step: "command_copied", surface: "welcome", note: SENTINEL });
  recordOnboardingStep("token", { step: "command_copied", surface: SENTINEL });
  await settle();
  assert.equal(sent.length, 0);
  recordOnboardingStep("token", { step: "command_copied", surface: "welcome" });
  await settle();
  assert.deepEqual(sent, [{ step: "command_copied", surface: "welcome", device: "desktop_web" }]);
});

test("an app start leaves as its declared fields; text in place of one is not sent", async (t) => {
  const sent = capturedDiagnosticPosts(t);
  markStartup("shell");
  reportStartupTiming("token", SENTINEL);
  await settle();
  assert.equal(sent.length, 0);
  reportStartupTiming("token", "warm");
  await settle();
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent).includes("SENTINEL"));
  assert.deepEqual(Object.keys(sent[0]).sort(), ["cache", "device", "shell"]);
});

const assert = require("node:assert/strict");
const test = require("node:test");

require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { configureDiagnosticsConsent } = require("./diagnostics-preference.ts");
const { reportDesktopDaemonFailure } = require("./desktop-daemon-failure-report.ts");
const { recordOnboardingStep } = require("./onboarding-funnel.ts");
const { reportClientDefect } = require("./client-defect-report.ts");

/** Every diagnostics request a page makes, by path. */
function captureSends(t) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    sent.push(new URL(String(input), "https://app.example.test").pathname);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return sent;
}

/** A Hub answering for an account that signed up where diagnostics are default-ok, read from `requestRegime`. */
function travellingAccount(requestRegime) {
  configureDiagnosticsConsent({
    read: async () => ({ accountRegime: "default-ok", requestRegime, choice: null }),
    write: async () => {},
  }, { build: "beta", environment: { now: () => 1, storage: null, doNotTrack: null, globalPrivacyControl: false } });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const failure = (detail) => ({ stage: "spawn", exitCode: 1, detail });
const app = { platform: "darwin", version: "1.0.0" };

test.afterEach(() => configureDiagnosticsConsent(null, { environment: null }));

test("from a consent-required country a default-ok account's page sends nothing automatic", async (t) => {
  globalThis.window ??= globalThis;
  const sent = captureSends(t);
  travellingAccount("consent-required");
  recordOnboardingStep("token", { surface: "space", step: "app_loaded" });
  reportDesktopDaemonFailure("token", failure("blocked automatic"), app);
  reportClientDefect("Couldn't accept the invite", new Error("blocked defect"));
  await settle();
  assert.deepEqual(sent, []);
});

test("where both regimes are default-ok the beta page sends its diagnostics", async (t) => {
  globalThis.window ??= globalThis;
  const sent = captureSends(t);
  travellingAccount("default-ok");
  recordOnboardingStep("token", { surface: "space", step: "app_loaded" });
  reportDesktopDaemonFailure("token", failure("allowed automatic"), app);
  reportClientDefect("Couldn't accept the invite", new Error("allowed defect"));
  await settle();
  assert.deepEqual(sent.sort(), [
    "/api/client-defects",
    "/api/xmatrix/observable/desktop-daemon-failure",
    "/api/xmatrix/observable/onboarding-step",
  ]);
});

test("a failure report the person sends from the card goes even where automatic ones may not", async (t) => {
  const sent = captureSends(t);
  travellingAccount("consent-required");
  reportDesktopDaemonFailure("token", failure("explicit"), app, { explicit: true });
  await settle();
  assert.deepEqual(sent, ["/api/xmatrix/observable/desktop-daemon-failure"]);
});

const assert = require("node:assert/strict");
const test = require("node:test");

require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { parseDesktopDaemonFailureReport } = require("@xmatrix/protocol");
const { reportDesktopDaemonFailure } = require("./desktop-daemon-failure-report.ts");
const { capturedDiagnosticPosts } = require("./diagnostic-posts-test-capture.cjs");

// Privacy contract (docs/guide/privacy.md): the CLI's last lines leave the
// machine only when the person presses Send on the failure card. The opted-in
// automatic report is its declared fields alone, which the Hub accepts.
const SENTINEL = "SENTINEL /Users/ada/private-project: permission denied";
const app = { platform: "darwin", version: "1.0.540" };

test("the automatic report never carries the CLI's lines; the person's Send does", async (t) => {
  const sent = capturedDiagnosticPosts(t);
  const failure = { stage: "exit", exitCode: 1, detail: SENTINEL };
  reportDesktopDaemonFailure("token", failure, app);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(sent[0]).includes("SENTINEL"));
  assert.deepEqual(parseDesktopDaemonFailureReport(sent[0]), { stage: "exit", exitCode: 1, platform: "darwin", appVersion: "1.0.540" });

  // The automatic report does not stand in for the person's own.
  reportDesktopDaemonFailure("token", failure, app, { explicit: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(parseDesktopDaemonFailureReport(sent[1])?.detail, SENTINEL);
});

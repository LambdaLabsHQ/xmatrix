import assert from "node:assert/strict";
import test from "node:test";
import {
  clientErrorReport, diagnosticStackFrame, parseClientDefectReport, parseDesktopDaemonFailureReport,
  parseOnboardingFunnelEvent, parseStartupTimingReport,
} from "../dist/index.js";

// Privacy contract (docs/guide/privacy.md): a diagnostic event is its declared
// fields, each an enum, number, boolean, opaque id, code or version. Text a
// person wrote cannot reach the Hub through any field, whether smuggled in a
// key nobody declared or in a value of a declared one.
const SENTINEL = "SENTINEL private message body";

const events = [
  ["onboarding step", parseOnboardingFunnelEvent, { step: "command_copied", surface: "welcome", device: "phone" }],
  ["startup timing", parseStartupTimingReport, { device: "phone", cache: "warm", shell: 180 }],
  ["daemon start failure", parseDesktopDaemonFailureReport, { stage: "exit", exitCode: 1, platform: "darwin", appVersion: "1.0.540" }],
  ["browser defect", parseClientDefectReport,
    { action: "That didn't work", name: "TypeError", stack: "    at load (https://xmatrix.sh/app.js:10:20)" }],
];

for (const [name, parse, valid] of events) {
  test(`a ${name} is its declared fields, and message text in any field refuses it`, () => {
    assert.ok(parse(valid));
    assert.equal(parse({ ...valid, message: SENTINEL }), undefined, "an undeclared key");
    for (const key of Object.keys(valid)) {
      assert.equal(parse({ ...valid, [key]: SENTINEL }), undefined, key);
    }
  });
}

test("a daemon start failure carries the CLI's lines only in the field the person sends from the card", () => {
  const automatic = parseDesktopDaemonFailureReport({ stage: "spawn", platform: "win32", appVersion: "2.3.0-beta.4" });
  assert.deepEqual(automatic, { stage: "spawn", platform: "win32", appVersion: "2.3.0-beta.4" });
  const sent = parseDesktopDaemonFailureReport({ stage: "exit", platform: "darwin", appVersion: "1.0.540", detail: "daemon.lock: denied" });
  assert.equal(sent?.detail, "daemon.lock: denied");
  assert.equal(parseDesktopDaemonFailureReport({ stage: "exit", platform: "darwin", appVersion: "1.0.540", detail: "x".repeat(601) }),
    undefined);
});

test("a browser defect's stack is code locations; a frame that names anything else reads anonymous", () => {
  const stack = [
    diagnosticStackFrame({ function: SENTINEL.replaceAll(" ", "\""), filename: "https://xmatrix.sh/app.js?code=SENTINEL", lineno: 3, colno: 4 }),
    diagnosticStackFrame({ function: "?", filename: SENTINEL }),
  ].join("\n");
  assert.equal(stack, "    at <anonymous> (https://xmatrix.sh/app.js:3:4)\n    at <anonymous> (<unknown>:0:0)");
  assert.ok(parseClientDefectReport({ action: "That didn't work", name: "Error", code: "rate_limited", stack }));
  assert.equal(parseClientDefectReport({ action: "That didn't work", name: "Error",
    stack: `Error: ${SENTINEL}\n    at load (https://xmatrix.sh/app.js:10:20)` }), undefined);
});

test("a browser error report is the error's class, code and code locations; nothing it said leaves", () => {
  const error = Object.assign(new TypeError(SENTINEL), { code: "invalid_state" });
  const report = clientErrorReport({
    type: undefined, event_id: "e1", timestamp: 1, platform: "javascript", level: "error", release: "web-1",
    message: SENTINEL,
    exception: { values: [{ type: "TypeError", value: SENTINEL, mechanism: { type: "onerror", handled: false, data: { note: SENTINEL } },
      stacktrace: { frames: [{ filename: `https://xmatrix.sh/app.js?q=${SENTINEL}`, function: "load", lineno: 10, colno: 20, vars: { body: SENTINEL } }] } }] },
    breadcrumbs: [{ category: "ui.click", message: SENTINEL }],
    request: { url: `https://xmatrix.sh/app/${SENTINEL}`, headers: { "User-Agent": "Mozilla/5.0 (Macintosh)", Cookie: SENTINEL } },
    user: { email: SENTINEL }, tags: { component: "web", note: SENTINEL }, extra: { line: 3, script: "https://xmatrix.sh/a.js", body: SENTINEL },
    contexts: { browser: { name: "Chrome", version: "131" }, culture: { locale: SENTINEL } },
  }, error);
  assert.ok(!JSON.stringify(report).includes("SENTINEL"));
  assert.deepEqual(report.exception.values, [{ type: "TypeError", value: "invalid_state", mechanism: { type: "onerror", handled: false },
    stacktrace: { frames: [{ filename: "https://xmatrix.sh/app.js", function: "load", lineno: 10, colno: 20 }] } }]);
  assert.deepEqual(report.extra, { line: 3, script: "https://xmatrix.sh/a.js" });
  assert.equal(clientErrorReport({ type: undefined, message: SENTINEL }, undefined), null, "a captured message is not sent");
});

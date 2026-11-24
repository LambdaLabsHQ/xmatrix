import assert from "node:assert/strict";
import test from "node:test";
import {
  clientErrorReport, diagnosticStackFrame, parseClientDefectReport, parseDesktopDaemonFailureReport,
  parseOnboardingFunnelEvent, parseStartupTimingReport,
} from "../dist/index.js";
import { scrubDiagnosticText, serverErrorReport } from "../dist/error-report-contract.js";

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

// The Hub's structured evidence (attempts, phases, codes, durations) leaves in
// the JSON shape its reporters wrote; a leaf the contract does not declare, or
// a declared leaf holding text, is dropped however deep it sits.
const backend = { state: "idle in transaction", wait: "Lock", owner: "op:content.ref.commit", ageMs: 40,
  queryName: "content_ref_insert_v1", queryAgeMs: 12, stateAgeMs: 30 };
const lockWait = { status: "sampled", waiter: backend, blockers: [backend] };
const serverExtras = {
  database_failure_attempts: [{ operation: "app.gmail-routing.finish", shardId: "shard-0", statement: "transaction",
    phase: "begin", queryName: "database_phase_begin_v1", code: "40P01", durationMs: 12,
    driverReason: "pg_connection_terminated", lockWait, queryWait: lockWait,
    session: { wallMs: 1, queueMs: 2, checkoutMs: 3, beginMs: 4, sqlMs: 5, sqlMaxMs: 6, commitMs: 7, roundTrips: 8, queries: 9 } }],
  message_search_failure: { channelFiltered: true, authorFilter: "agent", resumed: false, cursorPresent: true, scanned: 200, requested: 50 },
  cli_release_notice_failure: [{ channel: "dev", phase: "feed_body", attempt: 2, durationMs: 30, responseStatus: 503 }],
  apple_commerce_watch_failure: [{ phase: "grant", status: 0, kind: "transport", code: "TimeoutError", retryRecorded: true }],
  harness_release_watch_failure: { phase: "runtime_fetch", durationMs: 10, responseStatus: 0, retryable: true, overloaded: false },
  durable_object_failure: { operation: "POST /api/spaces/:id", retryable: true, overloaded: false,
    socket: { cell: "owner", durationMs: 9, remote: "unavailable", reason: "request_count" } },
};

/** Every plain object inside a value, outermost first. */
const objectsIn = (value) => !value || typeof value !== "object" ? []
  : [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(objectsIn)];
const serverExtra = (extra) =>
  serverErrorReport({ type: undefined, exception: { values: [{ type: "Error", value: "failed" }] }, extra }).extra;

for (const [key, evidence] of Object.entries(serverExtras)) {
  test(`a server report keeps ${key} in its reporter's JSON shape and drops a sentinel in any leaf`, () => {
    assert.deepEqual(JSON.parse(serverExtra({ [key]: JSON.stringify(evidence) })[key]), evidence);
    const planted = structuredClone(evidence);
    for (const object of objectsIn(planted)) object.note = SENTINEL;
    assert.deepEqual(JSON.parse(serverExtra({ [key]: JSON.stringify(planted) })[key]), evidence, "an undeclared leaf");
    const leaves = objectsIn(structuredClone(evidence))
      .flatMap((object, index) => Object.keys(object).filter((field) => typeof object[field] !== "object").map((field) => [index, field]));
    for (const [index, field] of leaves) {
      const smuggled = structuredClone(evidence);
      objectsIn(smuggled)[index][field] = SENTINEL;
      assert.ok(!JSON.stringify(serverExtra({ [key]: JSON.stringify(smuggled) }) ?? {}).includes("SENTINEL"), `${key} ${field}`);
    }
    assert.equal(serverExtra({ [key]: SENTINEL }), undefined, "text that is not its JSON");
    assert.equal(clientErrorReport({ type: undefined, exception: { values: [{ type: "Error" }] },
      extra: { [key]: JSON.stringify(evidence) } }, undefined).extra, undefined, "never from a browser");
  });
}

test("a server report keeps a deadlock wait graph and drops other text and undeclared structured extras", () => {
  const locks = "1>2:ShareLock:transaction;2>1:ShareLock:transaction";
  assert.deepEqual(serverExtra({ postgres_conflict_locks: locks, postgres_conflict_relation: "runs" }),
    { postgres_conflict_locks: locks, postgres_conflict_relation: "runs" });
  assert.equal(serverExtra({ postgres_conflict_locks: `${locks};${SENTINEL}` }), undefined);
  assert.equal(serverExtra({ undeclared_failure: JSON.stringify({ code: "x", note: SENTINEL }) }), undefined);
});

test("server text keeps a logged list of function names and still drops a token", () => {
  const origin = "origin=verifySignedMachineDaemonCredential,verifyMachineDaemonCredential,PostgresMachineDaemonPort.refresh";
  assert.equal(scrubDiagnosticText(`failure errorClass=Error ${origin} token=PRIVATE_SENTINEL`),
    `failure errorClass=Error ${origin} token=…`);
});

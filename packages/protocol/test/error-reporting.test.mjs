import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { bundleFrame, consoleLine, reportError, sendErrorReports, startErrorReporting } from "../dist/error-reporting.js";

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: String(init.body) });
  return new Response("{}", { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; });

/** The event items of every envelope sent so far. */
const events = () => sent.flatMap(({ body }) => body.split("\n")
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((item) => item?.event_id && (item.exception || item.message || item.logentry)));

test("a Worker without a DSN sends nothing", async () => {
  startErrorReporting({ dsn: undefined, release: "xmatrix-v1", component: "hub" });
  reportError(new Error("unreported"));
  console.error("unreported log");
  await sendErrorReports();
  assert.equal(sent.length, 0);
});

test("a reported failure reaches the DSN's project with its stack, release and component", async () => {
  startErrorReporting({ dsn: "https://key@o1.ingest.us.sentry.io/2", release: "xmatrix-v1", component: "hub" });
  reportError(new Error("hub failure"));
  await sendErrorReports();
  assert.ok(sent.every(({ url }) => url.startsWith("https://o1.ingest.us.sentry.io/api/2/envelope/")));
  const [event] = events();
  assert.equal(event.exception.values[0].value, "hub failure");
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0);
  assert.equal(event.release, "xmatrix-v1");
  assert.equal(event.environment, "production");
  assert.equal(event.tags.component, "hub");
  assert.equal(event.request, undefined);
  assert.equal(event.user, undefined);
});

test("a logged error is reported; other console lines are not", async () => {
  sent.length = 0;
  console.warn("not an error");
  console.log("routine line");
  console.error("Sentry event recovery failed");
  await sendErrorReports();
  const reported = events();
  assert.equal(reported.length, 1);
  assert.match(JSON.stringify(reported[0]), /Sentry event recovery failed/u);
});

test("a bundled Worker frame is reported under the uploaded source map's URL", async () => {
  sent.length = 0;
  const error = new Error("Query read timeout");
  error.stack = [
    "Error: Query read timeout",
    "    at maintainAccountDeletions (index.js:165430:24)",
    "    at PgAuthorityDatabase.transaction (index.js:88818:14)",
  ].join("\n");
  reportError(error);
  await sendErrorReports();
  const exception = events()[0].exception.values[0];
  assert.equal(exception.mechanism.data?.stack_origin, undefined);
  const frames = exception.stacktrace.frames;
  assert.deepEqual(frames.map(({ filename, abs_path, lineno }) => [filename, abs_path, lineno]), [
    ["app:///index.js", "app:///index.js", 88818],
    ["app:///index.js", "app:///index.js", 165430],
  ]);
});

test("frames with a root or a scheme keep their path", () => {
  for (const filename of ["/srv/hub/index.js", "file:///srv/hub/index.js", "node:internal/process", "app:///index.js"]) {
    assert.equal(bundleFrame({ filename }).filename, filename);
  }
  assert.deepEqual(bundleFrame({ function: "native" }), { function: "native" });
});

test("a logged line is titled with the facts it logged, not [object Object] (XMATRIX-HUB-7B)", async () => {
  sent.length = 0;
  console.error("xMatrix runtime authority rejection", {
    code: "runtime.authority_rejected", authorityCode: "machine_command_result_mismatch",
    diagnosticId: "diag_1", retryable: false, operation: "MachineControlError", status: 409,
  });
  await sendErrorReports();
  const [event] = events();
  const title = "xMatrix runtime authority rejection code=runtime.authority_rejected " +
    "authorityCode=machine_command_result_mismatch diagnosticId=diag_1 retryable=false " +
    "operation=MachineControlError status=409";
  assert.equal(event.exception?.values[0].value ?? event.message, title);
  assert.doesNotMatch(JSON.stringify([event.message, event.exception]), /\[object Object\]/u);
});

test("a logged line spells out scalar fields and leaves nested values to the report's arguments", () => {
  assert.equal(consoleLine(["failed", { errorClass: "TypeError", origin: ["a", "b"], nested: { secret: 1 }, empty: "" }]),
    "failed errorClass=TypeError origin=a,b");
  assert.equal(consoleLine(["plain line"]), "plain line");
  assert.equal(consoleLine(["x", { text: "y".repeat(1000) }]).length, 400);
});

// The platform can transport an Error without its originating JavaScript stack.
// Protect the reporting boundary: the existing normal-Error tests cannot catch
// losing every application frame for that different runtime shape.
test("a stackless platform error retains a labeled, source-mappable capture boundary (XMATRIX-HUB-9C/88)", async () => {
  sent.length = 0;
  const error = new Error("Durable Object storage is no longer accessible.");
  error.stack = undefined;
  runInNewContext('function recordDirectoryFailure() { console.error("Runtime route-directory register failed", error); } recordDirectoryFailure();',
    { console, error }, { filename: "index.js" });
  await sendErrorReports();
  const [event] = events();
  const exception = event.exception.values[0];
  assert.equal(exception.value, error.message);
  assert.equal(exception.mechanism.data.stack_origin, "capture_boundary");
  const caller = exception.stacktrace.frames.find(frame => frame.function?.includes("recordDirectoryFailure"));
  assert.equal(caller?.filename, "app:///index.js");
  assert.equal(caller?.abs_path, "app:///index.js");
  assert.equal(caller?.lineno, 1);
  assert.equal(error.stack, undefined, "reporting must not mutate the originating error");
});

import assert from "node:assert/strict";
import test from "node:test";
import { bundleFrame, reportError, sendErrorReports, startErrorReporting } from "../dist/error-reporting.js";

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
  const frames = events()[0].exception.values[0].stacktrace.frames;
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

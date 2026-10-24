import assert from "node:assert/strict";
import test from "node:test";
import { sendErrorReports, startErrorReporting } from "@xmatrix/protocol/error-reporting";
import { RuntimeSocketState } from "../src/runtime-transport/ordered-socket-dispatch.ts";
import { createAuthorityDatabase } from "@xmatrix/db";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";

test("unclassified socket failures retain bounded origin names in the Sentry envelope (XMATRIX-HUB-7H)", async () => {
  const envelopes = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    envelopes.push(String(init.body));
    return new Response("{}", { status: 200 });
  };
  try {
    startErrorReporting({ dsn: "https://key@o1.ingest.us.sentry.io/2", release: "test", component: "hub" });
    const error = new Error("token=PRIVATE_SENTINEL");
    error.stack = [
      "Error: token=PRIVATE_SENTINEL",
      "    at verifySignedMachineDaemonCredential (index.js:10:2)",
      "    at async verifyMachineDaemonCredential (index.js:20:2)",
      "    at async PostgresMachineDaemonPort.refresh (index.js:30:2)",
      "    at async MachineDaemonRuntimeTransport.refresh (index.js:40:2)",
      "    at ignoredFifthFrame (index.js:50:2)",
    ].join("\n");
    const replies = [];
    const sockets = new RuntimeSocketState("test", (_id, message, failure) => ({ message, failure }), () => {});
    await sockets.answerOperation({ send: (raw) => replies.push(JSON.parse(raw)) }, "refresh", "Request failed",
      async () => { throw error; });
    await sendErrorReports();
    const events = envelopes.flatMap((body) => body.split("\n").map((line) => JSON.parse(line)))
      .filter((item) => item.event_id && item.exception);
    assert.equal(events.length, 1);
    assert.match(events[0].exception.values[0].value,
      /origin=verifySignedMachineDaemonCredential,verifyMachineDaemonCredential,PostgresMachineDaemonPort.refresh,MachineDaemonRuntimeTransport.refresh/u);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|ignoredFifthFrame|\[Array\]/u);
    assert.equal(replies[0].failure.code, "runtime.session_failed");
    assert.equal(replies[0].failure.retryable, false);
    assert.doesNotMatch(JSON.stringify(replies), /PRIVATE_SENTINEL|verifySigned/u);
  } finally {
    globalThis.fetch = fetch;
  }
});

// The DB tests own transaction recovery. This boundary must retain the client's
// evidence in the one event actually sent, without publishing private errors.
test("unclassified runtime database failures retain phase and mapped origin once (XMATRIX-HUB-A6)", async (t) => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  const driverError = Object.assign(new Error("PRIVATE_SENTINEL SQL and credentials", {
    cause: new Error("PRIVATE_SENTINEL cause"),
  }), { code: "22023", detail: "PRIVATE_SENTINEL detail" });
  driverError.stack = [
    "DatabaseError: PRIVATE_SENTINEL",
    "PRIVATE_SENTINEL multiline SQL",
    "    at openTransaction (index.js:101:7)",
    "    at async PgAuthorityDatabaseSession.open (app:///index.js:202:9)",
    "    at privateFrame (https://user:PRIVATE_SENTINEL@example.test/index.js:1:2)",
  ].join("\n");
  const calls = [];
  const database = createAuthorityDatabase({ connectionString: "postgres://PRIVATE_SENTINEL", shardId: "shard-0",
    clientFactory: () => ({ connect: async () => {}, end: async () => {}, async query(input) {
      calls.push(input);
      if (input !== "ROLLBACK") throw driverError;
      return { rows: [] };
    } }) });
  const replies = [];
  const sockets = new RuntimeSocketState("test", (_id, message, failure) => ({ message, failure }), () => {});
  await sockets.answerOperation({ send: raw => replies.push(JSON.parse(raw)) }, "request", "Request failed",
    () => database.transaction({ requestId: "PRIVATE_SENTINEL", operation: "machine.report" }, async () => {
      assert.fail("an opening failure must not run the command");
    }));
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 1, "no second console-only issue");
  const [event] = events;
  assert.equal(event.tags.operation, "runtime.database");
  assert.equal(event.extra.diagnosticId, replies[0].failure.diagnosticId);
  const [attempt] = JSON.parse(event.extra.database_failure_attempts);
  assert.equal(attempt.operation, "machine.report");
  assert.equal(attempt.phase, "begin");
  assert.equal(attempt.queryName, "database_phase_begin_v1");
  assert.equal(attempt.code, "22023");
  assert.equal(event.extra.runtime_database_reason, "unclassified");
  const frames = event.exception.values[0].stacktrace.frames;
  assert.deepEqual(frames.map(({ filename, lineno }) => [filename, lineno]), [
    ["app:///index.js", 202], ["app:///index.js", 101],
  ]);
  const metadata = sentryEventMetadata({ tags: [{ key: "operation", value: event.tags.operation }], context: event.extra });
  assert.ok(metadata.includes("Capture operation: runtime.database"));
  assert.ok(metadata.some(line => line.startsWith("Database failure 1: machine.report · shard-0 · transaction · begin · database_phase_begin_v1 · 22023 ·")));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|postgres:\/\/|user:/u);
  assert.equal(calls.length, 2, "one failed BEGIN and one rollback, no blind replay");
  assert.equal(calls[1], "ROLLBACK");
  assert.equal(replies[0].failure.code, "runtime.session_failed");
  assert.equal(replies[0].failure.retryable, false);
  assert.doesNotMatch(JSON.stringify(replies), /machine.report|22023|PRIVATE_SENTINEL/u);
  // The same SQLSTATE can mean pool exhaustion or a provider internal error.
  // Distinguish exact documented messages without admitting arbitrary text.
  for (const [message, reason] of [
    ["Internal error.", "hyperdrive_internal"],
    ["Failed to acquire a connection from the pool.", "hyperdrive_pool_acquire"],
    ["Server connection attempt failed: connection_refused", "hyperdrive_connection_refused"],
    ["Internal error. PRIVATE_SENTINEL", "unclassified"],
  ]) {
    driverError.message = message;
    driverError.code = "58000";
    await sockets.answerOperation({ send() {} }, "request", "Request failed",
      () => database.transaction({ requestId: "PRIVATE_SENTINEL", operation: "machine.report" }, async () => {}));
    await sendErrorReports();
    const latest = exceptionEvents(envelopes).at(-1);
    assert.equal(latest.extra.runtime_database_reason, reason);
    assert.ok(sentryEventMetadata({ context: latest.extra }).includes(`Runtime database reason: ${reason}`));
  }
  assert.equal(exceptionEvents(envelopes).length, 5, "different provider reasons are not deduplicated");
  assert.deepEqual(sentryEventMetadata({ context: { runtime_database_reason: "PRIVATE_SENTINEL" } }), []);
  assert.doesNotMatch(JSON.stringify(exceptionEvents(envelopes)), /PRIVATE_SENTINEL/u);
});

import { exceptionEvents } from "./support/error-reports.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import { startErrorReporting, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { scheduledTaskFailed } from "../src/scheduled-task-failure.ts";
import { watchHarnessReleasesBesidePostgres } from "../src/harness-release-watch.ts";

// The existing DB tests check retry behavior; only a sent envelope proves a
// stackless scheduled failure retains its task and its attempt evidence once.
test("scheduled failures send exactly one event with task and database evidence", async () => {
  const envelopes = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async (_url, init) => { envelopes.push(String(init.body)); return new Response("{}"); };
  console.warn = () => {};
  try {
    startErrorReporting({ dsn: "https://key@o1.ingest.us.sentry.io/2", release: "xmatrix-vtest", component: "hub" });
    const database = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId: "shard-0",
      poolFactory: () => ({ async connect() { return { async query() { throw new Error("Query read timeout"); },
        release() {} }; }, async end() {} }) });
    let failure;
    try { await database.transaction({ requestId: "private-id", operation: "app.gmail-routing.finish" }, () => Promise.resolve()); }
    catch (error) { failure = error; }
    assert.ok(failure);
    const aggregate = new AggregateError([failure], "Channel deletion maintenance requires retry");
    scheduledTaskFailed("Channel deletion maintenance", aggregate);
    const stackless = new Error("Network connection lost.");
    stackless.stack = undefined;
    scheduledTaskFailed("Gmail notification recovery and renewal", stackless);
    const transport = Object.assign(new Error("Network connection lost."), { retryable: true, overloaded: false });
    transport.stack = undefined;
    const bodyFailure = Object.assign(new Error("Network connection lost."), { overloaded: true });
    bodyFailure.stack = undefined;
    const calls = [];
    // Overlapping failures must retain their own stage/status/flags. Neither
    // a lost fetch nor a severed response permits replaying committed notices.
    await Promise.all([transport, bodyFailure].map(async (failure, index) => {
      const env = { RELAY_RUNTIME: { idFromName: () => "cell", get: () => ({ fetch: async () => {
        calls.push(index);
        if (index === 0) throw failure;
        return { status: 200, json: async () => { throw failure; } };
      } }) } };
      try { await watchHarnessReleasesBesidePostgres(env); assert.fail("the task must still fail"); }
      catch (error) {
        assert.equal(error.cause, failure, "the original rejection remains available");
        scheduledTaskFailed("Harness release watch", error);
      }
    }));
    assert.deepEqual(calls.sort(), [0, 1], "one call per pass, without a transport replay");
    await sendErrorReports();
    const events = exceptionEvents(envelopes);
    assert.equal(events.length, 4, "one report per failed task, including transport and transient PG failures");
    const event = events.find(value => value.tags.operation === "scheduled: Channel deletion maintenance");
    const attempts = JSON.parse(event.extra.database_failure_attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].operation, "app.gmail-routing.finish");
    assert.equal(attempts[0].phase, "begin");
    assert.doesNotMatch(JSON.stringify(event.extra), /private-|postgres:\/\//);
    const platform = events.find(value => value.tags.operation === "scheduled: Gmail notification recovery and renewal");
    assert.equal(platform.exception.values[0].mechanism.data.stack_origin, "capture_boundary");
    assert.ok(platform.exception.values[0].stacktrace.frames.length);
    const harness = events.filter(value => value.tags.operation === "scheduled: Harness release watch")
      .map(value => JSON.parse(value.extra.harness_release_watch_failure))
      .sort((a, b) => a.phase.localeCompare(b.phase));
    assert.deepEqual(harness.map(({ durationMs: _durationMs, ...evidence }) => evidence), [
      { phase: "response_body", responseStatus: 200, retryable: false, overloaded: true },
      { phase: "runtime_fetch", responseStatus: 0, retryable: true, overloaded: false },
    ]);
    assert.ok(harness.every(value => Number.isSafeInteger(value.durationMs) && value.durationMs >= 0));
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

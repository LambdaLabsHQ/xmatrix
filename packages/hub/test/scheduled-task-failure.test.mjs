import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import { startErrorReporting, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { scheduledTaskFailed } from "../src/scheduled-task-failure.ts";

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
    await sendErrorReports();
    const events = envelopes.flatMap(body => body.split("\n").map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })).filter(value => value?.event_id && value.exception);
    assert.equal(events.length, 2, "one report per failed task, including transient PG failures");
    const event = events.find(value => value.tags.operation === "scheduled: Channel deletion maintenance");
    const attempts = JSON.parse(event.extra.database_failure_attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].operation, "app.gmail-routing.finish");
    assert.equal(attempts[0].phase, "begin");
    assert.doesNotMatch(JSON.stringify(event.extra), /private-|postgres:\/\//);
    const platform = events.find(value => value.tags.operation === "scheduled: Gmail notification recovery and renewal");
    assert.equal(platform.exception.values[0].mechanism.data.stack_origin, "capture_boundary");
    assert.ok(platform.exception.values[0].stacktrace.frames.length);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

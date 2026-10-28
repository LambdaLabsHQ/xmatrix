import { exceptionEvents } from "./support/error-reports.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase, PostgresFeishuRoomRepository } from "@xmatrix/db";
import { startErrorReporting, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { scheduledTaskFailed } from "../src/scheduled-task-failure.ts";
import { watchHarnessReleasesBesidePostgres } from "../src/harness-release-watch.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";

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

// HUB-AV exhausted recovery in SQL, then BEGIN. Generic retry tests cannot
// prove that the sent event and issue reader retain each session's progress.
test("Feishu's exhausted replay exposes independent session timings without changing recovery", async t => {
  let now = 100, created = 0;
  t.mock.method(performance, "now", () => now);
  const envelopes = [], pools = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    envelopes.push(String(init.body)); return new Response("{}");
  });
  t.mock.method(console, "warn", () => {});
  startErrorReporting({ dsn: "https://key@o1.ingest.us.sentry.io/2", release: "xmatrix-vtest", component: "hub" });
  const database = createAuthorityDatabase({ connectionString: "postgres://private-host", shardId: "shard-0",
    poolFactory: () => {
      const index = created++, pool = { ended: false, queries: [], destroyed: false };
      pools.push(pool);
      return { async connect() {
        assert.ok(pools.slice(0, index).every(previous => previous.ended));
        now += index === 0 ? 7 : 13;
        return { async query(input) {
          const sql = typeof input === "string" ? input : input.text;
          pool.queries.push(sql);
          if (index === 0 && sql.startsWith("BEGIN;")) { now += 11; return { rows: [] }; }
          now += 5000;
          throw new Error("Query read timeout");
        }, release(destroy) { pool.destroyed = destroy; } };
      }, async end() { pool.ended = true; } };
    } });
  await assert.rejects(new PostgresFeishuRoomRepository(database).cleanup({ requestId: "private-request" }), error => {
    scheduledTaskFailed("Feishu lifecycle maintenance", error); return /Query read timeout/u.test(error.message);
  });
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 1);
  const attempts = JSON.parse(events[0].extra.database_failure_attempts);
  assert.deepEqual(attempts.map(({ phase, session }) => ({ phase, session })), [
    { phase: "sql", session: { wallMs: 5018, queueMs: 0, checkoutMs: 7, beginMs: 11,
      sqlMs: 5000, sqlMaxMs: 5000, commitMs: 0, roundTrips: 2, queries: 1 } },
    { phase: "begin", session: { wallMs: 5013, queueMs: 0, checkoutMs: 13, beginMs: 5000,
      sqlMs: 0, sqlMaxMs: 0, commitMs: 0, roundTrips: 1, queries: 0 } },
  ]);
  const metadata = sentryEventMetadata({ context: events[0].extra }).join("\n");
  assert.match(metadata, /Database session 1: wall=5018 ms · queue=0 ms · checkout=7 ms · begin=11 ms · sql=5000 ms · max_sql=5000 ms · commit=0 ms · round_trips=2 · queries=1/);
  assert.match(metadata, /Database session 2: wall=5013 ms .*begin=5000 ms .*queries=0/);
  assert.doesNotMatch(JSON.stringify(events[0].extra) + metadata, /private-|DELETE FROM/);
  assert.equal(pools.length, 2, "no third attempt");
  assert.ok(pools.every(pool => pool.ended && pool.destroyed));
  assert.ok(pools.every(pool => !pool.queries.includes("COMMIT") && !pool.queries.includes("ROLLBACK")));
});

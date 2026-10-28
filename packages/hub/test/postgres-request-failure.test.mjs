import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { transientFailure } from "../src/error-contract.ts";
import { postgresMessageErrorResponse, postgresMessageSearch } from "../src/postgres-message-authority.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";

// The client owns named-query evidence. Exercise that boundary through the HTTP
// classifier and the connector, so a nested console object cannot pass this test.
test("deadlock reports retain the query and safe wait graph without changing retry semantics", async (t) => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  const conflict = Object.assign(new Error("deadlock detected"), { code: "40P01",
    detail: "Process 771 waits for ShareLock on transaction 991; blocked by process 772.\n" +
      "Process 772 waits for ExclusiveLock on tuple (1,2) of relation 123; blocked by process 771.\n" +
      "Process 771: UPDATE data.runs SET metadata_json='private-canary';",
    where: 'while locking tuple (11,12) in relation "runs"',
  });
  const database = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId: "shard-0",
    clientFactory: () => ({ connect: async () => {}, end: async () => {}, async query(input) {
      if (typeof input === "object") throw conflict;
      return { rows: [] };
    } }) });
  let failure;
  try { await database.transaction({ requestId: "private-request-id", operation: "page.edit" },
    tx => tx.query({ name: "agent_channel_registered_run_access_v2", text: "SELECT private_canary", maxRows: 1 })); }
  catch (error) { failure = error; }
  assert.equal(failure, conflict);
  const response = transientFailure(failure);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "transaction_conflict");
  assert.equal(response.body.retryable, true);
  assert.equal(response.headers["retry-after"], "1");
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 1);
  const event = events[0];
  const attempts = JSON.parse(event.extra.database_failure_attempts);
  assert.equal(attempts[0].operation, "page.edit");
  assert.equal(attempts[0].queryName, "agent_channel_registered_run_access_v2");
  assert.equal(attempts[0].code, "40P01");
  const metadata = sentryEventMetadata({ context: event.extra });
  assert.ok(metadata.includes("PostgreSQL deadlock waits (local process aliases): 1>2:ShareLock:transaction;2>1:ExclusiveLock:tuple"));
  assert.ok(metadata.includes("PostgreSQL deadlock relation: runs"));
  assert.doesNotMatch(JSON.stringify(event.extra), /private|771|772|991|UPDATE|SELECT|11,12/u);
  assert.deepEqual(sentryEventMetadata({ context: {
    postgres_conflict_locks: "private-canary", postgres_conflict_relation: "private-canary",
  } }), []);
});

// HUB-AZ reached the message-specific boundary, whose console capture lost
// the driver's WeakMap evidence. The common HTTP classifier does not own it.
test("message lock timeouts reach Sentry with database evidence and their original stack once", async t => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  const failure = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  failure.stack = "Error: canceling statement due to lock timeout\n    at channelLock (index.js:123:4)";
  const database = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId: "shard-0",
    clientFactory: () => ({ connect: async () => {}, end: async () => {}, async query(input) {
      if (typeof input === "object") throw failure;
      return { rows: [] };
    } }) });
  await assert.rejects(database.transaction({ requestId: "private-request", operation: "message.append" },
    tx => tx.query({ name: "channel_lifecycle_lock_runtime_new_work_v1",
      text: "SELECT private_canary", values: ["private-channel"], maxRows: 1 })), error => error === failure);
  const response = postgresMessageErrorResponse(failure);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "PostgreSQL message authority is unavailable",
    code: "postgres_message_authority_unavailable", retryable: true });
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 1);
  const event = events[0];
  const [attempt] = JSON.parse(event.extra.database_failure_attempts);
  assert.equal(attempt.operation, "message.append");
  assert.equal(attempt.queryName, "channel_lifecycle_lock_runtime_new_work_v1");
  assert.equal(attempt.code, "55P03");
  assert.equal(attempt.phase, "sql");
  assert.ok(event.exception.values[0].stacktrace.frames.some(frame => frame.function === "channelLock"));
  assert.ok(sentryEventMetadata({ context: event.extra }).some(line => line.startsWith("Database failure 1:")));
  assert.doesNotMatch(JSON.stringify(event.extra), /private-|SELECT|postgres:\/\//u);
});

// HUB-AG: console capture discarded the driver's linked retry evidence and
// search shape. Exercise the real search, driver recovery, reporter and reader.
test("exhausted search recovery reports both attempts and only bounded search shape", async (t) => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  for (const resumed of [false, true]) {
    let searchQueries = 0;
    const errors = [];
    const database = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId: "shard-0",
      clientFactory: () => ({ connect: async () => {}, end: async () => {}, async query(input) {
        if (input.text.includes("SELECT space_id, shard_id, placement_epoch, state,")) return { rows: [{ space_id: "private-space",
          shard_id: "shard-0", placement_epoch: 1, state: "active", target_shard_id: null, plan_class: "standard" }] };
        searchQueries++;
        if (resumed && searchQueries === 1) return { rows: Array.from({ length: 1000 }, (_, i) => ({
          __xmatrix_fence_shard_id: "shard-0", __xmatrix_fence_placement_epoch: 1,
          __xmatrix_fence_state: "active", __xmatrix_fence_target_shard_id: null, __xmatrix_read_row: true,
          message_id: `private-message-${i}`, channel_id: "private-channel", timeline_sequence: i + 1,
          entity_version: 1, search_rank_sequence: `private-rank-${i}`, author_kind: "agent",
          author_id: "private-author", legacy_body: "not a match", sent_at: "2026-10-26T00:00:00Z",
        })) };
        const error = new Error("Query read timeout");
        error.stack = `Error: Query read timeout\n    at messageSearch (index.js:${resumed ? 321 : 123}:4)`;
        errors.push(error);
        throw error;
      } }) });
    let failure;
    await assert.rejects(postgresMessageSearch({}, { spaceId: "private-space", query: "private-query",
      principal: { kind: "user", id: "private-principal" }, channelId: "private-channel",
      from: resumed ? { kind: "agent", name: "private-agent" } : { kind: "user", userId: "private-user" },
      ...(resumed ? { resumeToken: "private-cursor" } : {}),
    }, { database }), error => { failure = error; return true; });
    assert.equal(failure, errors[1], "the original driver error keeps its classification and stack");
    assert.equal(errors.length, 2, "recovery remains one fresh attempt");
    const response = transientFailure(failure);
    assert.deepEqual([response.status, response.body.code, response.body.retryable, response.headers["retry-after"]],
      [503, "postgres_unavailable", true, "2"]);
    await sendErrorReports();
    const event = exceptionEvents(envelopes).at(-1);
    assert.equal(event.tags.operation, "postgres.unavailable");
    const attempts = JSON.parse(event.extra.database_failure_attempts);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(attempt => attempt.operation === "message.search" && attempt.phase === "sql" &&
      attempt.statement === "single_read" && attempt.code === "QUERY_READ_TIMEOUT"));
    const shape = JSON.parse(event.extra.message_search_failure);
    assert.deepEqual(shape, { channelFiltered: true, authorFilter: resumed ? "agent" : "user", resumed,
      cursorPresent: resumed, scanned: resumed ? 1000 : 0, requested: 1000 });
    const metadata = sentryEventMetadata({ context: event.extra });
    assert.ok(metadata.some(line => line.includes(`scanned=${resumed ? 1000 : 0}`)));
    assert.equal(metadata.filter(line => line.startsWith("Database failure ")).length, 2);
    assert.doesNotMatch(JSON.stringify(event.extra), /private-|SELECT|postgres:\/\//u);
  }
  assert.equal(exceptionEvents(envelopes).length, 2, "one event per failed search");
});

test("the issue reader rejects arbitrary search diagnostics", () => {
  const valid = { channelFiltered: false, authorFilter: "none", resumed: false,
    cursorPresent: false, scanned: 0, requested: 1000 };
  for (const value of [null, "{", JSON.stringify(null), JSON.stringify({ ...valid, query: "private-query" }),
    JSON.stringify({ ...valid, scanned: -1 }), JSON.stringify({ ...valid, requested: 1001 }),
    JSON.stringify({ ...valid, authorFilter: "private-author" }), JSON.stringify({ ...valid, resumed: "private" })]) {
    assert.deepEqual(sentryEventMetadata({ context: { message_search_failure: value } }), []);
  }
});

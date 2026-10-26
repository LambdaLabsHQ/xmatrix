import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { transientFailure } from "../src/error-contract.ts";
import { postgresMessageSearch } from "../src/postgres-message-authority.ts";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";

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

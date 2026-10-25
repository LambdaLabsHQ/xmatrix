import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { transientFailure } from "../src/error-contract.ts";
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLifecycleOptions,
  runLifecycleMaintenance,
} from "../scripts/postgres-lifecycle-maintenance.mjs";

function client(deleteCounts = [], reservationDeleteCounts = [], executionDeleteCounts = []) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes("FROM pg_class")) return { rows: [] };
      if (text.includes("FROM data.outbox GROUP BY")) return { rows: [] };
      if (text.includes("expiredIdempotencyRowsCapped")) assert.fail("unexpected label in SQL");
      if (text.includes("AS idempotency_rows")) return { rows: [{
        idempotency_rows: 7, sequence_reservation_rows: 3, message_execution_rows: 2,
        scoped_command_replay_rows: 4,
      }] };
      if (text.includes("DELETE FROM data.idempotency_keys")) {
        const rowCount = deleteCounts.shift() ?? 0;
        return { rows: Array.from({ length: rowCount }), rowCount };
      }
      if (text.includes("DELETE FROM data.message_sequence_reservations")) {
        const rowCount = reservationDeleteCounts.shift() ?? 0;
        return { rows: Array.from({ length: rowCount }), rowCount };
      }
      if (text.includes("DELETE FROM data.agent_message_executions")) {
        const rowCount = executionDeleteCounts.shift() ?? 0;
        return { rows: Array.from({ length: rowCount }), rowCount };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function assertBoundedExpiryDeletes(deletes) {
  for (const { text } of deletes) {
    assert.match(text, /expires_at<=(?:clock_timestamp|now)\(\)/u);
    assert.match(text, /FOR UPDATE SKIP LOCKED/u);
    assert.doesNotMatch(text, /data\.(?:outbox|message_mutations)/u);
  }
}

test("lifecycle options enforce the reviewed batch, total, and time ceilings", () => {
  assert.deepEqual(parseLifecycleOptions([]), {
    dryRun: false, batchSize: 1_000, maxRows: 10_000, budgetMs: 30_000,
  });
  assert.deepEqual(parseLifecycleOptions([
    "--dry-run", "--batch-size=1000", "--max-rows=100000", "--budget-ms=90000",
  ]), { dryRun: true, batchSize: 1_000, maxRows: 100_000, budgetMs: 90_000 });
  assert.throws(() => parseLifecycleOptions(["--batch-size=1001"]), /between 1 and 1000/u);
  assert.throws(() => parseLifecycleOptions(["--max-rows=100001"]), /between 1 and 100000/u);
  assert.throws(() => parseLifecycleOptions(["--sql=DELETE"]), /Unknown or duplicate/u);
});

test("dry-run reports lifecycle state without opening a write transaction", async () => {
  const fake = client();
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions(["--dry-run"]));
  assert.equal(result.deletedExpiredIdempotencyRows, 0);
  assert.equal(result.deletedExpiredSequenceReservationRows, 0);
  assert.equal(result.batches, 0);
  assert.equal(fake.calls.some(({ text }) => text.includes("DELETE FROM")), false);
  fake.calls.forEach(({ text }, index) => {
    if (text === "BEGIN") assert.equal(fake.calls[index + 1].text, "SET TRANSACTION READ ONLY");
  });
  assert.equal(result.before.expiredIdempotencyRowsCapped, 7);
  assert.equal(result.before.expiredSequenceReservationRowsCapped, 3);
  assert.equal(result.before.expiredMessageExecutionRowsCapped, 2);
  assert.equal(result.before.expiredScopedCommandReplayRowsCapped, 4);
});

test("maintenance deletes only expired idempotency rows in bounded batches", async () => {
  const fake = client([1_000, 1_000, 500]);
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions([
    "--batch-size=1000", "--max-rows=2500", "--budget-ms=30000",
  ]));
  assert.equal(result.deletedExpiredIdempotencyRows, 2_500);
  assert.equal(result.deletedExpiredSequenceReservationRows, 0);
  const deletes = fake.calls.filter(({ text }) => text.includes("DELETE FROM data.idempotency_keys"));
  assert.deepEqual(deletes.map(({ values }) => values[0]), [1_000, 1_000, 500]);
  assertBoundedExpiryDeletes(deletes);
  const reservationDeletes = fake.calls.filter(
    ({ text }) => text.includes("DELETE FROM data.message_sequence_reservations"),
  );
  assert.equal(reservationDeletes.length, 1);
  assert.match(reservationDeletes[0].text, /FOR UPDATE SKIP LOCKED/u);
});

test("maintenance deletes expired PostgreSQL sequence reservations with the same bounds", async () => {
  const fake = client([], [1_000, 250]);
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions([
    "--batch-size=1000", "--max-rows=2500", "--budget-ms=30000",
  ]));
  assert.equal(result.deletedExpiredIdempotencyRows, 0);
  assert.equal(result.deletedExpiredSequenceReservationRows, 1_250);
  assert.deepEqual(result.batchesByRelation, { idempotency: 1, sequenceReservation: 2, messageExecution: 1, wecomInstallAttempt: 1, dingtalkCompanyAttempt: 1, scopedCommandReplay: 1 });
  const deletes = fake.calls.filter(
    ({ text }) => text.includes("DELETE FROM data.message_sequence_reservations"),
  );
  assert.deepEqual(deletes.map(({ values }) => values[0]), [1_000, 1_000]);
  assertBoundedExpiryDeletes(deletes);
});

test("maintenance stops starting batches when its wall-time budget is exhausted", async () => {
  const fake = client([1_000, 1_000]);
  const ticks = [0, 0, 30_001, 30_001];
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions([]), {
    monotonicNow: () => ticks.shift() ?? 30_001,
  });
  assert.equal(result.deletedExpiredIdempotencyRows, 1_000);
  assert.equal(result.batches, 1);
});

test("execution history expiry retains unexpired rows and shares the maintenance bounds", async () => {
  const fake = client([], [], [1000, 10]);
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions([]));
  assert.equal(result.deletedExpiredMessageExecutionRows, 1010);
  const queries = fake.calls.filter(call => call.text.includes("DELETE FROM data.agent_message_executions"));
  assert.deepEqual(queries.map(query => query.values[0]), [1000, 1000]);
  for (const query of queries) {
    assert.match(query.text, /expires_at<=clock_timestamp\(\)/u);
    assert.match(query.text, /FOR UPDATE SKIP LOCKED/u);
  }
});
/** A fake whose deletes from `table` find `remaining` expired rows in total. */
function clientWithExpired(table, remaining) {
  const fake = client();
  const original = fake.query;
  fake.query = async (text, values) => {
    if (!text.includes(`DELETE FROM ${table}`)) return original(text, values);
    fake.calls.push({ text, values });
    const rowCount = Math.min(remaining, values[0]); remaining -= rowCount;
    return { rows: Array.from({ length: rowCount }), rowCount };
  };
  return fake;
}

test("maintenance purges expired private WeCom installation attempts within its shared row and time limits", async () => {
  const fake = clientWithExpired("data.app_wecom_install_attempts", 3);
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions(["--batch-size=2", "--max-rows=3"]));
  assert.equal(result.deletedExpiredWeComInstallAttempts, 3);
  const deletes = fake.calls.filter(value => value.text.includes("DELETE FROM data.app_wecom_install_attempts"));
  assert.deepEqual(deletes.map(value => value.values[0]), [2, 1]); assertBoundedExpiryDeletes(deletes);
});

test("maintenance expires scoped command replays last, in bounded batches", async () => {
  const fake = clientWithExpired("control.scoped_control_command_replays", 2_500);
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions(["--max-rows=2000"]));
  assert.equal(result.deletedExpiredScopedCommandReplays, 2_000);
  const deletes = fake.calls.filter(value => value.text.includes("DELETE FROM control.scoped_control_command_replays"));
  assert.deepEqual(deletes.map(value => value.values[0]), [1_000, 1_000]); assertBoundedExpiryDeletes(deletes);
  const lastDelete = fake.calls.findLastIndex(value => /DELETE FROM/u.test(value.text));
  assert.match(fake.calls[lastDelete].text, /control\.scoped_control_command_replays/u);
});

test("the snapshot reads one statement at a time under its own read-only timeout", async () => {
  const fake = client();
  let inFlight = 0;
  const original = fake.query;
  fake.query = async (text, values) => {
    assert.equal(inFlight, 0, "a pg client must not be handed overlapping queries");
    inFlight += 1;
    try { return await original(text, values); } finally { inFlight -= 1; }
  };
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions(["--dry-run"]));
  const texts = fake.calls.map(({ text }) => text);
  assert.equal(texts.filter((text) => text === "SET TRANSACTION READ ONLY").length, 2);
  const begin = texts.indexOf("BEGIN");
  assert.deepEqual(texts.slice(begin, begin + 3),
    ["BEGIN", "SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '30s'"]);
  assert.equal(texts.filter((text) => /FROM data\.outbox/u.test(text)).length, 2,
    "one outbox scan per snapshot");
  assert.ok(texts.indexOf("SET statement_timeout = '5s'") < begin);
  assert.deepEqual(Object.keys(result.before.oldest), [
    "idempotency_oldest_at", "sequence_reservation_oldest_at", "outbox_oldest_at",
    "message_execution_oldest_at", "mutation_oldest_at",
  ]);
});

test("the oldest outbox row comes from the per-status scan", async () => {
  const fake = client();
  const original = fake.query;
  fake.query = async (text, values) => text.includes("FROM data.outbox GROUP BY")
    ? { rows: [
      { status: "delivered", oldest_at: new Date("2026-09-12T00:00:00Z") },
      { status: "pending", oldest_at: new Date("2026-09-09T00:00:00Z") },
    ] }
    : original(text, values);
  const result = await runLifecycleMaintenance(fake, parseLifecycleOptions(["--dry-run"]));
  assert.deepEqual(result.before.oldest.outbox_oldest_at, new Date("2026-09-09T00:00:00Z"));
});

test("a snapshot failure names the read that failed and rolls back", async () => {
  const fake = client();
  const original = fake.query;
  fake.query = async (text, values) => {
    if (text.includes("FROM data.outbox GROUP BY")) {
      fake.calls.push({ text, values });
      throw new Error("canceling statement due to statement timeout");
    }
    return original(text, values);
  };
  await assert.rejects(runLifecycleMaintenance(fake, parseLifecycleOptions([])),
    /lifecycle snapshot outbox by status: canceling statement due to statement timeout/u);
  assert.equal(fake.calls.at(-1).text, "ROLLBACK");
  assert.equal(fake.calls.some(({ text }) => text.includes("DELETE FROM")), false);
});

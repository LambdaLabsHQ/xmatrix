import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectivityBreaker,
  connectivityFailureCode,
  createAuthorityDatabase,
  DatabaseCircuitOpenError,
} from "../dist/index.js";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

const refused = (fn) => {
  try { fn(); } catch (error) { return error; }
  assert.fail("expected the breaker to refuse");
};

test("only path failures count; transaction and contract failures never trip the breaker", () => {
  for (const code of ["ETIMEDOUT", "econnreset", "08006", "57P03", "53300", "CONNECT_TIMEOUT", "QUERY_READ_TIMEOUT"]) {
    assert.equal(connectivityFailureCode(code), true, code);
  }
  for (const code of ["40001", "40P01", "23505", "57014", "42703", "DATABASE_CONTRACT_ERROR", "database_error",
    "database_circuit_open"]) {
    assert.equal(connectivityFailureCode(code), false, code);
  }
});

test("a burst of failures opens, a probe after the cooldown closes, a failed probe backs off", () => {
  const time = clock();
  const breaker = new ConnectivityBreaker("shard-0", time.now);
  for (let index = 0; index < 4; index++) { breaker.admit(); breaker.failure(); }
  assert.deepEqual(breaker.admit(), { probe: false }, "four failures keep it closed");
  breaker.failure();

  const open = refused(() => breaker.admit());
  assert.ok(open instanceof DatabaseCircuitOpenError);
  assert.equal(open.code, "database_circuit_open");
  assert.equal(open.retryable, true);
  assert.equal(open.retryAfterMs, 5_000);

  time.advance(5_000);
  assert.deepEqual(breaker.admit(), { probe: true }, "one probe after the cooldown");
  assert.equal(refused(() => breaker.admit()).retryAfterMs, 1_000, "others wait while it is in flight");
  breaker.failure();
  assert.equal(refused(() => breaker.admit()).retryAfterMs, 10_000, "a failed probe doubles the cooldown");

  time.advance(10_000);
  assert.deepEqual(breaker.admit(), { probe: true });
  breaker.success();
  assert.deepEqual(breaker.admit(), { probe: false }, "a successful statement closes it");
});

test("failures spread beyond the window never open it, and cooldown is capped", () => {
  const time = clock();
  const breaker = new ConnectivityBreaker("shard-0", time.now);
  for (let index = 0; index < 10; index++) { breaker.failure(); time.advance(3_000); }
  assert.deepEqual(breaker.admit(), { probe: false });

  const stuck = new ConnectivityBreaker("shard-1", time.now);
  for (let index = 0; index < 5; index++) stuck.failure();
  for (let round = 0; round < 6; round++) {
    time.advance(30_000);
    stuck.admit();
    stuck.failure();
  }
  assert.equal(refused(() => stuck.admit()).retryAfterMs, 30_000);
});

test("an open breaker fails new sessions before any connection is attempted", async () => {
  const time = clock();
  const breaker = new ConnectivityBreaker("shard-0", time.now);
  let connects = 0;
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/db", shardId: "shard-0", connectivityBreaker: breaker,
    clientFactory: () => ({
      async connect() {
        connects += 1;
        const error = new Error("connect ETIMEDOUT");
        error.code = "ETIMEDOUT";
        throw error;
      },
      async query() { assert.fail("no SQL may run"); },
      async end() {},
    }),
  });
  const context = { requestId: "request-1", operation: "message.append" };
  const run = () => database.transaction(context, async () => "unreachable");

  for (let index = 0; index < 5; index++) await assert.rejects(run(), { code: "ETIMEDOUT" });
  assert.equal(connects, 5);
  await assert.rejects(run(), (error) => error instanceof DatabaseCircuitOpenError && error.retryAfterMs === 5_000);
  assert.equal(connects, 5, "the open breaker refused without connecting");
});

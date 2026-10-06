import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectivityBreaker,
  createAuthorityDatabase,
  DatabaseCircuitOpenError,
  DatabaseCommitUnknownError,
  DatabaseContractError,
  DatabasePlacementStaleError,
  DatabaseRowLimitError,
  SpacePlacementHints,
} from "../dist/index.js";

function fakeFactory(options = {}) {
  const calls = [];
  const clients = [];
  let remainingConnectFailures = options.connectFailures ?? 0;
  const factory = (config) => {
    const client = {
      config,
      async connect() {
        calls.push({ kind: "connect" });
        if (remainingConnectFailures > 0) {
          remainingConnectFailures -= 1;
          throw new Error("redacted connection failure");
        }
      },
      async query(input) {
        const text = typeof input === "string" ? input : input.text;
        calls.push({ kind: "query", input });
        if (options.failOn?.test(text)) {
          const error = new Error("redacted database failure");
          error.code = options.failureCode ?? "40001";
          throw error;
        }
        if (text === "SELECT many") {
          return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        }
        if (text.includes("__xmatrix_fence_shard_id")) {
          const rows = options.placedReadRows ?? [];
          return { rows, rowCount: rows.length };
        }
        if (text.includes("FROM control.space_placement")) {
          const rows = options.placementRows ?? [{ shard_id: "shard-0", placement_epoch: 2,
            state: "active", target_shard_id: null }];
          return { rows, rowCount: rows.length };
        }
        return { rows: text === "SELECT one" ? [{ id: 1 }] : [], rowCount: 0 };
      },
      async end() { calls.push({ kind: "end" }); },
    };
    clients.push(client);
    return client;
  };
  return { calls, clients, factory };
}

/** The one message that opens a transaction: BEGIN, its settings, and any placement fence. */
const opening = (input) => typeof input === "string" &&
  /^BEGIN(?: ISOLATION LEVEL SERIALIZABLE)?;/u.test(input);

const context = {
  requestId: "request-1",
  operation: "message.append",
  placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 2 },
};

test("authority database applies transaction-local context and closes every client", async () => {
  const { fake, observations, database } = observedDatabase();
  const result = await database.transaction(context, async (transaction) => {
    return transaction.query({ name: "one_v1", text: "SELECT one", maxRows: 1 });
  });

  assert.deepEqual(result, [{ id: 1 }]);
  assert.equal(database.cacheMode, "disabled");
  assert.equal(fake.clients[0].config.connectionTimeoutMillis, 3_000);
  assert.equal(fake.clients[0].config.max, 1);
  const texts = fake.calls.filter((call) => call.kind === "query")
    .map((call) => typeof call.input === "string" ? call.input : call.input.text);
  assert.equal(opening(texts[0]), true, "BEGIN, the settings, and the fence share one round trip");
  assert.match(texts[0], /set_config\('xmatrix\.placement_epoch', '2', true\)/u);
  assert.match(texts[0], /FROM control\.space_placement\s+WHERE space_id='space-1'/u);
  assert.equal(texts[1], "SELECT one");
  assert.equal(texts.at(-1), "COMMIT");
  assert.equal(
    fake.calls.some((call) => call.kind === "query" &&
      typeof call.input !== "string" && "name" in call.input),
    false,
    "Hyperdrive queries must not depend on backend-session prepared statements",
  );
  assert.equal(fake.calls.at(-1).kind, "end");
  assert.deepEqual(
    observations.filter((observation) => observation.queryName === "one_v1")
      .map(({ requestId, operation, queryName, shardId, outcome, rowCount }) => ({
      requestId, operation, queryName, shardId, outcome, rowCount,
      })),
    [{
      requestId: "request-1",
      operation: "message.append",
      queryName: "one_v1",
      shardId: "shard-0",
      outcome: "ok",
      rowCount: 1,
    }],
  );
  assert.deepEqual(
    observations.filter((observation) => observation.queryName.startsWith("database_phase_"))
      .map((observation) => observation.queryName),
    [
      "database_phase_pool_checkout_v1",
      "database_phase_begin_v1",
      "database_phase_commit_v1",
    ],
  );
});

test("a serializable transaction carries its isolation in the opening message", async () => {
  const { fake, database } = observedDatabase();
  await database.transaction({ ...context, isolation: "serializable" }, async () => undefined);
  const queries = fake.calls.filter((call) => call.kind === "query").map((call) => call.input);
  assert.match(queries[0], /^BEGIN ISOLATION LEVEL SERIALIZABLE;SELECT/u);
  assert.deepEqual(queries.slice(1), ["COMMIT"]);
});

test("opening settings are quoted literals that cannot end their string", async () => {
  const { fake, database } = observedDatabase();
  const hostile = "a'); DROP TABLE data.messages; --\\'";
  await database.transaction({ ...context, requestId: hostile }, async () => undefined);
  const [first] = fake.calls.filter((call) => call.kind === "query").map((call) => call.input);
  assert.ok(first.includes(
    "set_config('xmatrix.request_id',  E'a''); DROP TABLE data.messages; --\\\\''', true)"), first);
  await assert.rejects(
    database.transaction({ ...context, requestId: "nul\u0000byte" }, async () => undefined),
    /transaction setting is invalid/u,
  );
});

test("a refused fence forgets the Space's placement hint", async () => {
  const hints = new SpacePlacementHints();
  hints.remember({ spaceId: "space-1", shardId: "shard-0", placementEpoch: 2,
    state: "active", targetShardId: null, planClass: "shared" });
  const fake = fakeFactory({ placementRows: [{ shard_id: "shard-0", placement_epoch: 3,
    state: "active", target_shard_id: null }] });
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0",
    clientFactory: fake.factory, placementHints: hints,
  });
  assert.equal(database.placementHints, hints);
  assert.equal(database.openSession().placementHints, hints);
  await assert.rejects(database.transaction(context, async () => assert.fail("work must not run")),
    (error) => error instanceof DatabasePlacementStaleError && error.spaceId === "space-1");
  assert.equal(hints.get("space-1"), undefined);
});

test("a session emits one summary splitting wait, checkout, and SQL time", async () => {
  const fake = fakeFactory();
  const sessions = [];
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: fake.factory,
    sessionObserver: (summary) => sessions.push(summary),
  });
  const session = database.openSession();
  await Promise.all([
    session.transaction(context, (transaction) => transaction.query({
      name: "many_v1", text: "SELECT many", maxRows: 2,
    })),
    session.transaction({ ...context, operation: "message.read" }, async (transaction) => {
      await transaction.query({ name: "one_v1", text: "SELECT one", maxRows: 1 });
      await transaction.query({ name: "one_v1", text: "SELECT one", maxRows: 1 });
    }),
  ]);
  assert.equal(sessions.length, 0, "the summary waits for close");
  await session.close();
  await session.close();
  assert.equal(sessions.length, 1);
  const [summary] = sessions;
  assert.equal(summary.operation, "message.append");
  assert.equal(summary.shardId, "shard-0");
  assert.equal(summary.outcome, "ok");
  assert.equal(summary.errorCode, undefined);
  assert.equal(summary.transactions, 2);
  assert.equal(summary.queries, 3);
  assert.equal(summary.rows, 4);
  assert.equal(summary.roundTrips, 2 * 2 + 3, "an opening and COMMIT per transaction plus SQL");
  for (const field of ["wallMs", "queueMs", "checkoutMs", "firstStatementMs", "beginMs",
    "sqlMs", "sqlMaxMs", "commitMs", "rollbackMs"]) {
    assert.ok(Number.isFinite(summary[field]) && summary[field] >= 0, field);
  }
  assert.ok(summary.sqlMaxMs <= summary.sqlMs);
  assert.ok(summary.wallMs >= summary.sqlMs);
});

test("session summaries separate database failures from business rollbacks", async () => {
  const cases = [
    [fakeFactory({ failOn: /SELECT broken/u, failureCode: "57014" }), "error", "57014"],
    [fakeFactory(), "rollback", undefined],
  ];
  for (const [fake, outcome, code] of cases) {
    const sessions = [];
    const database = createAuthorityDatabase({
      connectionString: "postgres://example.invalid/xmatrix",
      shardId: "shard-0",
      clientFactory: fake.factory,
      sessionObserver: (summary) => sessions.push(summary),
    });
    await assert.rejects(database.transaction(context, async (transaction) => {
      await transaction.query({ name: "broken_v1", text: "SELECT broken", maxRows: 1 });
      throw new Error("callback gave up");
    }));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].outcome, outcome);
    assert.equal(sessions[0].errorCode, code);
    assert.ok(sessions[0].rollbackMs >= 0);
  }
});

test("authority database rolls back failures and emits no SQL or values", async () => {
  const fake = fakeFactory({ failOn: /SELECT broken/u });
  const observations = [];
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: fake.factory,
    observer: (observation) => observations.push(observation),
  });
  await assert.rejects(
    database.transaction(context, (transaction) => transaction.query({
      name: "broken_v1",
      text: "SELECT broken WHERE secret = $1",
      values: ["do-not-observe"],
      maxRows: 1,
    })),
    /redacted database failure/u,
  );
  assert.equal(fake.calls.some((call) => call.input === "ROLLBACK"), true);
  assert.equal(fake.calls.at(-1).kind, "end");
  assert.equal(observations.find((observation) => observation.queryName === "broken_v1").errorCode,
    "40001");
  assert.equal(JSON.stringify(observations).includes("secret"), false);
  assert.equal(JSON.stringify(observations).includes("do-not-observe"), false);
});

test("request session reuses one max-one checkout and closes it exactly once", async () => {
  const { fake, database } = observedDatabase();
  const session = database.openSession();
  await session.transaction(context, (transaction) => transaction.query({
    name: "session_one_v1", text: "SELECT one", maxRows: 1,
  }));
  await session.transaction(context, (transaction) => transaction.query({
    name: "session_two_v1", text: "SELECT one", maxRows: 1,
  }));
  await session.close();
  await session.close();

  assert.equal(fake.clients.length, 1);
  assert.equal(fake.calls.filter((call) => call.kind === "connect").length, 1);
  assert.equal(fake.calls.filter((call) => call.kind === "end").length, 1);
  assert.equal(fake.calls.filter((call) => opening(call.input)).length, 2);
  assert.equal(fake.calls.filter((call) => call.input === "COMMIT").length, 2);
  await assert.rejects(session.transaction(context, async () => undefined), /session is closed/u);
});

test("request session serializes concurrent transactions on one physical shard", async () => {
  const { fake, database } = observedDatabase();
  const session = database.openSession();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered = false;
  let secondEntered = false;
  const first = session.transaction(context, async () => {
    firstEntered = true;
    await firstBlocked;
    return "first";
  });
  const second = session.transaction(context, async () => {
    secondEntered = true;
    return "second";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstEntered, true);
  assert.equal(secondEntered, false, "the second physical-shard transaction must wait");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(secondEntered, true);
  await session.close();
  assert.equal(fake.calls.filter((call) => opening(call.input)).length, 2);
  assert.equal(fake.calls.filter((call) => call.input === "COMMIT").length, 2);
  assert.equal(fake.calls.filter((call) => call.kind === "connect").length, 1);
});

test("request session is reusable after a failed pool checkout", async () => {
  const fake = fakeFactory({ connectFailures: 1 });
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: fake.factory,
  });
  const session = database.openSession();

  await assert.rejects(
    session.transaction(context, async () => undefined),
    /redacted connection failure/u,
  );
  const rows = await session.transaction(context, (transaction) => transaction.query({
    name: "recovered_checkout_v1", text: "SELECT one", maxRows: 1,
  }));
  await session.close();

  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(fake.calls.filter((call) => call.kind === "connect").length, 2);
});

test("connection loss during COMMIT is distinguished from a known failed transaction", async () => {
  const ambiguous = fakeFactory({ failOn: /^COMMIT$/u, failureCode: "08006" });
  const ambiguousDatabase = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: ambiguous.factory,
  });
  await assert.rejects(
    ambiguousDatabase.transaction(context, async () => "prepared"),
    (error) => error instanceof DatabaseCommitUnknownError && error.driverCode === "08006",
  );
  assert.equal(ambiguous.calls.some((call) => call.input === "ROLLBACK"), false);

  const determinate = fakeFactory({ failOn: /^COMMIT$/u, failureCode: "40001" });
  const determinateDatabase = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: determinate.factory,
  });
  await assert.rejects(
    determinateDatabase.transaction(context, async () => "prepared"),
    (error) => error.code === "40001",
  );
  assert.equal(determinate.calls.some((call) => call.input === "ROLLBACK"), true);
});

function failedWirePool(failOn, failure, rollbackFailure) {
  const queries = [];
  const releases = [];
  let fail = true;
  let ended = 0;
  const client = {
    async query(input) {
      const text = typeof input === "string" ? input : input.text;
      queries.push(text);
      if (text === "ROLLBACK" && rollbackFailure) throw rollbackFailure;
      if (fail && failOn.test(text)) { fail = false; throw failure; }
      return { rows: [], rowCount: 0 };
    },
    release(destroy) { releases.push(destroy); },
  };
  return {
    queries, releases,
    get ended() { return ended; },
    factory: () => ({
      async connect() { return client; },
      async end() { ended += 1; },
    }),
  };
}

test("lost wire responses discard the checkout without queuing rollback or another transaction", async () => {
  for (const [message, code] of [
    ["Query read timeout", "QUERY_READ_TIMEOUT"],
    ["Connection terminated unexpectedly", "CONNECTION_TERMINATED"],
  ]) for (const stage of [/^BEGIN;/u, /^SELECT stalled$/u, /^COMMIT$/u]) {
    const failure = new Error(message);
    const fake = failedWirePool(stage, failure);
    const observations = [];
    const database = createAuthorityDatabase({
      connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0",
      poolFactory: fake.factory, observer: (point) => observations.push(point),
    });
    const session = database.openSession();
    const request = { requestId: "read-timeout", operation: "message.append" };
    const first = session.transaction(request, (transaction) => transaction.query({
      name: "stalled_v1", text: "SELECT stalled", maxRows: 0,
    }));
    const queued = session.transaction(request, async () => assert.fail("poisoned checkout reused"));
    const [failed, rejected] = await Promise.allSettled([first, queued]);
    assert.equal(failed.status, "rejected");
    if (stage.test("COMMIT")) {
      assert.ok(failed.reason instanceof DatabaseCommitUnknownError);
      assert.equal(failed.reason.driverCode, code);
      assert.equal(failed.reason.cause, failure);
    } else {
      assert.equal(failed.reason, failure);
    }
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.reason.message, /session is unusable/u);
    assert.equal(fake.queries.includes("ROLLBACK"), false);
    assert.equal(fake.queries.filter(opening).length, 1);
    await session.close();
    await session.close();
    assert.deepEqual(fake.releases, [true]);
    assert.equal(fake.ended, 1);
    if (stage.test("SELECT stalled")) {
      assert.equal(observations.find((point) => point.queryName === "stalled_v1").errorCode, code);
    }
  }
});

/**
 * A max-one pool handing out a new client after each destroyed checkout.
 * `failures[n]` is what checkout n's first matching query throws. A placed
 * read answers with the admitted fence of `context.placement`.
 */
function retryPool(failOn, failures, fence = { __xmatrix_fence_shard_id: "shard-0",
  __xmatrix_fence_placement_epoch: 2, __xmatrix_fence_state: "active", __xmatrix_fence_target_shard_id: null }) {
  const clients = [];
  let current = null;
  return {
    clients,
    factory: () => ({
      async connect() {
        if (current) return current;
        const index = clients.length;
        const client = {
          queries: [], releases: [],
          async query(input) {
            const text = typeof input === "string" ? input : input.text;
            assert.equal(client.releases.includes(true), false, "a destroyed checkout was reused");
            client.queries.push(text);
            if (failures[index] && failOn.test(text)) throw failures[index];
            const row = text.includes("__xmatrix_fence_shard_id")
              ? { ...fence, __xmatrix_read_row: true, id: index } : { id: index };
            return { rows: [row], rowCount: 1 };
          },
          release(destroy) {
            client.releases.push(destroy);
            if (destroy) current = null;
          },
        };
        clients.push(client);
        current = client;
        return client;
      },
      async end() {},
    }),
  };
}

const singleRead = { requestId: "single-timeout", operation: "read", statement: "single_read" };
const readOne = (transaction) => transaction.query({ name: "read_v1", text: "SELECT one", maxRows: 1 });

test("a timed-out single read is retried once on a fresh checkout", async () => {
  for (const placement of [undefined, context.placement]) {
    const fake = retryPool(/single_read/u, [new Error("Query read timeout")]);
    const observations = [];
    const sessions = [];
    const session = createAuthorityDatabase({
      connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", poolFactory: fake.factory,
      observer: (point) => observations.push(point), sessionObserver: (summary) => sessions.push(summary),
    }).openSession();
    const request = { ...singleRead, ...(placement ? { placement } : {}) };
    assert.deepEqual(await session.transaction(request, readOne), [{ id: 1 }]);
    assert.equal(fake.clients.length, 2);
    assert.deepEqual(fake.clients[0].releases, [true], "the stalled checkout is destroyed");
    assert.equal(fake.clients[0].queries.length, 1);
    assert.deepEqual(await session.transaction(request, readOne), [{ id: 1 }], "the session stays usable");
    assert.equal(fake.clients.length, 2, "and keeps the retry's checkout");
    await session.close();
    assert.deepEqual(fake.clients[1].releases, [false]);
    assert.deepEqual(observations.filter((point) => point.queryName === "read_v1").map((point) => point.outcome),
      ["error", "ok", "ok"]);
    assert.equal(observations.filter((point) => point.queryName === "database_phase_pool_checkout_v1").length, 2);
    assert.equal(sessions[0].outcome, "error");
    assert.equal(sessions[0].errorCode, "QUERY_READ_TIMEOUT", "the first failure stays recorded");
    assert.equal(sessions[0].queries, 3);
  }
});

test("a second single-read timeout surfaces without a third attempt", async () => {
  const second = new Error("Query read timeout");
  const fake = retryPool(/single_read/u, [new Error("Query read timeout"), second, new Error("third")]);
  const session = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", poolFactory: fake.factory,
  }).openSession();
  await assert.rejects(session.transaction(singleRead, readOne), (error) => error === second);
  await assert.rejects(session.transaction(singleRead, readOne), /session is unusable/u);
  await session.close();
  assert.equal(fake.clients.length, 2);
  assert.deepEqual(fake.clients.map((client) => client.releases), [[true], [true]]);
});

test("answered single-read failures, explicit transactions and stale fences are never retried", async () => {
  for (const failure of [Object.assign(new Error("canceling statement"), { code: "57014" }),
    new Error("Connection terminated unexpectedly")]) {
    const fake = retryPool(/single_read/u, [failure]);
    await assert.rejects(createAuthorityDatabase({
      connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", poolFactory: fake.factory,
    }).transaction(singleRead, readOne), (error) => error === failure);
    assert.equal(fake.clients.length, 1);
  }

  const timeout = new Error("Query read timeout");
  const explicit = retryPool(/^SELECT one$/u, [timeout]);
  await assert.rejects(createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", poolFactory: explicit.factory,
  }).transaction({ requestId: "explicit", operation: "read" }, readOne), (error) => error === timeout);
  assert.equal(explicit.clients.length, 1);
  assert.equal(explicit.clients[0].queries.includes("ROLLBACK"), false);
  assert.deepEqual(explicit.clients[0].releases, [true]);

  const stale = retryPool(/never/u, [], { __xmatrix_fence_shard_id: "shard-1",
    __xmatrix_fence_placement_epoch: 3, __xmatrix_fence_state: "active", __xmatrix_fence_target_shard_id: null });
  await assert.rejects(createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", poolFactory: stale.factory,
  }).transaction({ ...singleRead, placement: context.placement }, readOne), DatabasePlacementStaleError);
  assert.equal(stale.clients.length, 1, "a refused fence is final");
  assert.equal(stale.clients[0].queries.length, 1);
});

test("an open breaker refuses the retry and the original timeout surfaces", async () => {
  const breaker = new ConnectivityBreaker("shard-0");
  // Four earlier failures: this read's timeout is the fifth and opens the breaker.
  for (let index = 0; index < 4; index++) breaker.failure();
  const failure = new Error("Query read timeout");
  const fake = retryPool(/single_read/u, [failure]);
  const observations = [];
  const session = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", poolFactory: fake.factory,
    connectivityBreaker: breaker, observer: (point) => observations.push(point),
  }).openSession();
  await assert.rejects(session.transaction(singleRead, readOne), (error) => error === failure);
  assert.equal(fake.clients.length, 1, "no second checkout");
  assert.deepEqual(fake.clients[0].releases, [true]);
  assert.equal(observations.at(-1).queryName, "database_phase_pool_checkout_v1");
  assert.equal(observations.at(-1).errorCode, "database_circuit_open");
  await assert.rejects(session.transaction(singleRead, readOne), /session is unusable/u);
  await session.close();
  assert.throws(() => breaker.admit(), DatabaseCircuitOpenError);
});

test("the client-factory pool destroys a released checkout and connects afresh", async () => {
  const fake = fakeFactory();
  let timeouts = 1;
  const factory = (config) => {
    const client = fake.factory(config);
    const query = client.query;
    client.query = async (input) => {
      const text = typeof input === "string" ? input : input.text;
      if (timeouts > 0 && /single_read/u.test(text)) { timeouts -= 1; throw new Error("Query read timeout"); }
      return query({ ...input, text: "SELECT one" });
    };
    return client;
  };
  const rows = await createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", clientFactory: factory,
  }).transaction(singleRead, readOne);
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(fake.clients.length, 2);
  assert.equal(fake.calls.filter((call) => call.kind === "end").length, 2, "both clients end exactly once");
});

test("server statement timeouts roll back and allow reuse; failed rollback discards the checkout", async () => {
  for (const rollbackFailure of [undefined, new Error("Query read timeout")]) {
    const failure = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const fake = failedWirePool(/^SELECT stalled$/u, failure, rollbackFailure);
    const database = createAuthorityDatabase({
      connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0",
      poolFactory: fake.factory,
    });
    const session = database.openSession();
    const request = { requestId: "server-timeout", operation: "read" };
    await assert.rejects(session.transaction(request, (transaction) => transaction.query({
      name: "stalled_v1", text: "SELECT stalled", maxRows: 0,
    })), (error) => error === failure);
    assert.equal(fake.queries.includes("ROLLBACK"), true);
    if (rollbackFailure) {
      await assert.rejects(session.transaction(request, async () => undefined), /session is unusable/u);
    } else {
      assert.equal(await session.transaction(request, async () => "recovered"), "recovered");
    }
    await session.close();
    assert.deepEqual(fake.releases, [Boolean(rollbackFailure)]);
  }
});

test("authority database fails closed on result and query bounds", async () => {
  const { database } = observedDatabase();
  await assert.rejects(
    database.transaction(context, (transaction) => transaction.query({
      name: "many_v1",
      text: "SELECT many",
      maxRows: 1,
    })),
    DatabaseRowLimitError,
  );
  await assert.rejects(
    database.transaction(context, (transaction) => transaction.query({
      name: "invalid_v1",
      text: "SELECT one",
      maxRows: 10_001,
    })),
    DatabaseContractError,
  );
});

test("authority database rejects a placement routed to another physical shard", async () => {
  const { fake, database } = observedDatabase();
  await assert.rejects(
    database.health({
      requestId: "wrong-shard",
      operation: "postgres.readiness",
      placement: { spaceId: "space-1", shardId: "shard-1", placementEpoch: 1 },
    }),
    /placement shard does not match/u,
  );
  assert.equal(fake.clients.length, 0, "a mismatched placement must fail before connecting");
});

test("authority database rejects a missing Space placement row before domain SQL", async () => {
  const fake = fakeFactory({ placementRows: [{ shard_id: null, placement_epoch: null,
    state: null, target_shard_id: null }] });
  await assertPlacementRejected(fake);
});

test("authority database rejects a stale shard-local placement before domain SQL", async () => {
  const fake = fakeFactory({ placementRows: [{ shard_id: "shard-0", placement_epoch: 3,
    state: "active", target_shard_id: null }] });
  await assertPlacementRejected(fake);
});

test("infrastructure health carries the selected physical shard without inventing a Space", async () => {
  const { fake, observations, database } = observedDatabase();
  const health = await database.health({
    requestId: "health-request",
    operation: "postgres.readiness",
  });
  assert.equal(health.shardId, "shard-0");
  assert.equal(observations[0].shardId, "shard-0");
  const contextQuery = fake.calls.find((call) => call.kind === "query" && opening(call.input));
  assert.match(contextQuery.input, /set_config\('xmatrix\.request_id', 'health-request', true\)/u);
  assert.match(contextQuery.input, /set_config\('xmatrix\.space_id', '', true\)/u,
    "health must not synthesize a Space id");
  assert.match(contextQuery.input, /set_config\('xmatrix\.shard_id', 'shard-0', true\)/u);
  assert.match(contextQuery.input, /set_config\('xmatrix\.placement_epoch', '', true\)/u);
  assert.doesNotMatch(contextQuery.input, /space_placement/u,
    "an unplaced transaction takes no placement fence");
});

test("a single read runs as one statement without BEGIN or COMMIT", async () => {
  const { fake, observations, database } = observedDatabase();
  await database.transaction({ requestId: "read-1", operation: "channel.resolve-space",
    statement: "single_read" }, (transaction) => transaction.query({
    name: "route_v1", text: "SELECT route FROM routes WHERE id = $1", values: ["channel-1"], maxRows: 1,
  }));
  const queries = fake.calls.filter((call) => call.kind === "query");
  assert.equal(queries.length, 1);
  assert.match(queries[0].input.text, /set_config\('xmatrix\.request_id', \$6, true\)/u);
  assert.match(queries[0].input.text, /CROSS JOIN LATERAL \(SELECT route FROM routes WHERE id = \$1\)/u);
  assert.deepEqual(queries[0].input.values.slice(0, 2), ["channel-1", "xmatrix-hub"]);
  assert.equal(queries[0].input.values[5], "read-1");
  assert.deepEqual(observations.map((observation) => observation.queryName),
    ["database_phase_pool_checkout_v1", "route_v1"]);
});

test("a single read refuses a second query, row locks and writes", async () => {
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: fakeFactory().factory,
  });
  const read = { requestId: "read-2", operation: "read", statement: "single_read" };
  await assert.rejects(database.transaction(read, async (transaction) => {
    await transaction.query({ name: "a_v1", text: "SELECT one", maxRows: 1 });
    await transaction.query({ name: "b_v1", text: "SELECT one", maxRows: 1 });
  }), /allows one query/u);
  await assert.rejects(database.transaction(read, (transaction) => transaction.query({
    name: "lock_v1", text: "SELECT id FROM t WHERE id = $1 FOR SHARE", values: ["x"], maxRows: 1,
  })), /lock-free SELECT/u);
  await assert.rejects(database.transaction(read, (transaction) => transaction.query({
    name: "write_v1", text: "UPDATE t SET x = 1", maxRows: 1,
  })), /lock-free SELECT/u);
  await assert.rejects(database.transaction({ ...read, isolation: "serializable" },
    async () => undefined), /cannot carry isolation/u);
  await assert.rejects(database.transaction({ ...read, placement: context.placement }, (transaction) =>
    transaction.query({ name: "lock_v1", text: "SELECT id FROM t FOR UPDATE", maxRows: 1 })),
  /lock-free SELECT/u, "a placed single read admits no caller lock either");
  await assert.rejects(database.transaction({ ...read, placement: { ...context.placement, shardId: "shard-9" } },
    async () => undefined), /placement shard does not match/u);
});

const fence = { __xmatrix_fence_shard_id: "shard-0", __xmatrix_fence_placement_epoch: "2",
  __xmatrix_fence_state: "active", __xmatrix_fence_target_shard_id: null };

test("a placed single read fences its Space in the same statement and admits only read rows", async () => {
  const fake = fakeFactory({ placedReadRows: [
    { ...fence, __xmatrix_read_row: true, id: 1 }, { ...fence, __xmatrix_read_row: true, id: 2 },
  ] });
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", clientFactory: fake.factory,
  });
  const placed = { requestId: "placed-1", operation: "message.history", statement: "single_read",
    placement: context.placement };
  const rows = await database.transaction(placed, (transaction) => transaction.query({
    name: "page_v1", text: "SELECT id FROM page WHERE channel = $1 ORDER BY id", values: ["c"], maxRows: 2,
  }));
  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }], "fence columns never reach the caller");
  const queries = fake.calls.filter((call) => call.kind === "query");
  assert.equal(queries.length, 1, "no BEGIN, separate fence, or COMMIT round trip");
  const text = queries[0].input.text;
  assert.match(text, /FROM control\.space_placement\s+WHERE space_id=\$8 AND settings\.configured IS NOT NULL\s+FOR SHARE/u);
  assert.match(text, /FROM \(SELECT id FROM page WHERE channel = \$1 ORDER BY id\) placed_read\s+WHERE fence\.state IS NOT NULL/u);
  assert.deepEqual(queries[0].input.values.slice(0, 1), ["c"]);
  assert.equal(queries[0].input.values[7], "space-1");
  assert.equal(queries[0].input.values[8], "shard-0");
  assert.equal(queries[0].input.values[9], "2");

  // An empty read still returns its fence row, which is not a caller row.
  const empty = fakeFactory({ placedReadRows: [{ ...fence, __xmatrix_read_row: null }] });
  assert.deepEqual(await createAuthorityDatabase({ connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0", clientFactory: empty.factory }).transaction(placed, (transaction) =>
    transaction.query({ name: "page_v1", text: "SELECT id FROM page", maxRows: 1 })), []);

  const overfull = fakeFactory({ placedReadRows: [
    { ...fence, __xmatrix_read_row: true, id: 1 }, { ...fence, __xmatrix_read_row: true, id: 2 },
  ] });
  await assert.rejects(createAuthorityDatabase({ connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0", clientFactory: overfull.factory }).transaction(placed, (transaction) =>
    transaction.query({ name: "page_v1", text: "SELECT id FROM page", maxRows: 1 })), DatabaseRowLimitError);
});

test("a placed single read fails closed on a missing, moved, or stale fence", async () => {
  const placed = { requestId: "placed-2", operation: "message.history", statement: "single_read",
    placement: context.placement };
  for (const rows of [
    [],
    [{ __xmatrix_fence_shard_id: null, __xmatrix_fence_placement_epoch: null, __xmatrix_fence_state: null,
      __xmatrix_fence_target_shard_id: null, __xmatrix_read_row: null }],
    [{ ...fence, __xmatrix_fence_placement_epoch: "3", __xmatrix_read_row: true, id: 1 }],
    [{ ...fence, __xmatrix_fence_shard_id: "shard-1", __xmatrix_read_row: true, id: 1 }],
    [{ ...fence, __xmatrix_fence_state: "moving", __xmatrix_fence_target_shard_id: "shard-1",
      __xmatrix_read_row: true, id: 1 }],
    [{ ...fence, __xmatrix_fence_state: "blocked", __xmatrix_read_row: true, id: 1 }],
  ]) {
    const fake = fakeFactory({ placedReadRows: rows });
    await assert.rejects(createAuthorityDatabase({ connectionString: "postgres://example.invalid/xmatrix",
      shardId: "shard-0", clientFactory: fake.factory }).transaction(placed, (transaction) =>
      transaction.query({ name: "page_v1", text: "SELECT id FROM page", maxRows: 5 })),
    /local Space placement fence is stale/u, JSON.stringify(rows));
  }
});

function observedDatabase() {
  const fake = fakeFactory(), observations = [];
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix", shardId: "shard-0", clientFactory: fake.factory,
    observer: observation => observations.push(observation),
  });
  return { fake, observations, database };
}

async function assertPlacementRejected(fake) {
  const database = createAuthorityDatabase({
    connectionString: "postgres://example.invalid/xmatrix",
    shardId: "shard-0",
    clientFactory: fake.factory,
  });
  await assert.rejects(database.transaction(context, (transaction) => transaction.query({
    name: "must_not_run_v1", text: "SELECT one", maxRows: 1,
  })), /local Space placement fence is stale/u);
  assert.equal(fake.calls.some((call) => call.kind === "query" && typeof call.input !== "string" &&
    call.input.text === "SELECT one"), false);
  assert.equal(fake.calls.some((call) => call.input === "ROLLBACK"), true);
}

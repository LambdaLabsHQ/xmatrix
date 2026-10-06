import assert from "node:assert/strict";
import test from "node:test";

import {
  POSTGRES_OBSERVABILITY_SCHEMA,
  postgresDatabaseObservers,
  recordPostgresQueryObservation,
  recordPostgresReadinessSummary,
  recordPostgresSessionObservation,
  SESSION_SEGMENTS,
} from "../src/postgres-observability.ts";
import {
  POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA,
  recordAgentLaunchCoordinator,
  recordChannelReservationCleanup,
  recordMessageCoordination,
} from "../src/postgres-coordination-observability.ts";

function sink(overrides = {}) {
  const written = [];
  return {
    written,
    env: {
      RELAY_AUTHORITY_OBSERVABILITY_ENABLED: "true",
      RELAY_AUTHORITY_OBSERVABILITY_AE: { writeDataPoint: (point) => written.push(point) },
      CF_VERSION_METADATA: { id: "version-1" },
      ...overrides,
    },
  };
}

test("query telemetry has fixed privacy-safe slots and retains slow-query evidence", () => {
  const { env, written } = sink();
  recordPostgresQueryObservation(env, {
    requestId: "must-not-be-written",
    operation: "postgres.readiness",
    queryName: "postgres_health_v1",
    shardId: "shard-0",
    durationMs: 1_234,
    rowCount: 1,
    outcome: "ok",
    slow: true,
  });
  assert.deepEqual(written, [{
    indexes: [POSTGRES_OBSERVABILITY_SCHEMA],
    blobs: [
      "query", "postgres.readiness", "postgres_health_v1", "shard-0",
      "ok", "none", "version-1", "cache_disabled", "postgres_health_v1", "slow",
      "postgres.readiness",
    ],
    doubles: [1_234, 1, 1, 1],
  }]);
  assert.equal(JSON.stringify(written).includes("must-not-be-written"), false);
});

test("hostile dimensions and errors collapse into bounded buckets", () => {
  const { env, written } = sink();
  recordPostgresQueryObservation(env, {
    requestId: "request",
    operation: "secret-operation",
    queryName: "SELECT password",
    shardId: "customer@example.com",
    durationMs: Number.POSITIVE_INFINITY,
    rowCount: -10,
    outcome: "unexpected",
    slow: false,
    errorCode: "password=secret",
  });
  assert.deepEqual(written[0].blobs, [
    "query", "other", "other", "other", "error", "DATABASE_ERROR", "version-1", "cache_disabled",
    "other", "error", "other",
  ]);
  assert.deepEqual(written[0].doubles, [0, 0, 0, 1]);
});

test("client read deadlines remain distinguishable from server SQLSTATE timeouts", () => {
  const { env, written } = sink();
  for (const errorCode of ["QUERY_READ_TIMEOUT", "57014"]) {
    recordPostgresQueryObservation(env, {
      requestId: "private", operation: "channel-catalog.page",
      queryName: "channel_catalog_page_flat_all_v9", shardId: "shard-0",
      durationMs: 5_000, rowCount: 0, outcome: "error", slow: true, errorCode,
    });
  }
  assert.deepEqual(written.map((point) => point.blobs[5]), ["QUERY_READ_TIMEOUT", "57014"]);
});

test("hot-path operations retain bounded stage, transaction phase, and SQLSTATE", () => {
  const { env, written } = sink();
  const cases = [
    ["channel-catalog.page", "channel_catalog_page_tree_all_v7", "postgres.catalog", "catalog.sql"],
    ["channel-catalog.resolve", "channel_catalog_resolve_v6", "postgres.resolve", "resolve.sql"],
    ["message.history", "message_history_page_v1", "postgres.history", "history.sql"],
    ["message.append", "database_phase_commit_v1", "postgres.message", "phase.commit"],
    ["channel.direct-find", "channel_direct_find_v1", "postgres.direct", "direct.sql"],
    ["runtime.summon_prepare_resolved_batch_v2", "runtime_summon_v2_profiles_exact_v2",
      "postgres.launch", "launch_resolve"],
    ["runtime.summon_prepare_resolved_batch_v2", "runtime_summon_v2_runs_v1",
      "postgres.launch", "launch_prepare"],
    ["launch.directory-publish-many", "entity_space_route_publish_many_v1",
      "postgres.launch", "directory_publish"],
    ["machine-control.issue_batch", "machine_control_issue_batch_v1",
      "postgres.machine", "command_issue"],
  ];
  for (const [operation, queryName] of cases) recordPostgresQueryObservation(env, {
    requestId: "private", operation, queryName, shardId: "shard-0",
    durationMs: 2, rowCount: 0, outcome: "error", slow: false, errorCode: "40001",
  });
  assert.deepEqual(written.map((point) => point.blobs.slice(1, 6)), cases.map((entry) => [
    entry[2], entry[3], "shard-0", "error", "40001",
  ]));
});

test("operations outside the hot paths are grouped by their code-defined family", () => {
  const { env, written } = sink();
  for (const operation of ["space.create", "registration.launch.channel", "not-a-family.read"]) {
    recordPostgresQueryObservation(env, {
      requestId: "private", operation, queryName: "space_create_v3", shardId: "shard-0",
      durationMs: 3, rowCount: 1, outcome: "error", slow: false, errorCode: "CONNECTION_TERMINATED",
    });
  }
  assert.deepEqual(written.map((point) => point.blobs.slice(1, 3)), [
    ["postgres.space", "sql"], ["postgres.registration", "sql"], ["other", "other"],
  ]);
  assert.deepEqual(written.map((point) => point.blobs[5]), Array(3).fill("CONNECTION_TERMINATED"));
});

test("ordinary successful queries are thinned with a compensating weight", () => {
  const point = { requestId: "r", operation: "message.append", queryName: "message_append_v1",
    shardId: "shard-0", durationMs: 3, rowCount: 1, outcome: "ok", slow: false };
  const all = sink({ POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE: "1" });
  recordPostgresQueryObservation(all.env, point);
  assert.deepEqual(all.written[0].doubles.slice(3), [1]);
  assert.equal(all.written[0].blobs[9], "all");

  const thin = sink({ POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE: "10000" });
  for (let i = 0; i < 200; i += 1) recordPostgresQueryObservation(thin.env, point);
  assert.ok(thin.written.length < 5, "one in 10,000 keeps almost none of 200");
  for (const kept of thin.written) {
    assert.equal(kept.blobs[9], "sampled");
    assert.equal(kept.doubles[3], 10_000);
  }
  recordPostgresQueryObservation(thin.env, { ...point, slow: true });
  recordPostgresQueryObservation(thin.env, { ...point, outcome: "error", errorCode: "57014" });
  assert.deepEqual(thin.written.slice(-2).map((kept) => [kept.blobs[9], kept.doubles[3]]),
    [["slow", 1], ["error", 1]]);
});

test("session points carry every segment of one checkout in fixed slots", () => {
  const { env, written } = sink({ POSTGRES_SESSION_OBSERVABILITY_SAMPLE_RATE: "10000" });
  const summary = {
    operation: "channel-catalog.page", shardId: "shard-0", outcome: "ok", wallMs: 812,
    queueMs: 1, checkoutMs: 2, firstStatementMs: 600, beginMs: 600, sqlMs: 190,
    sqlMaxMs: 150, commitMs: 6, rollbackMs: 0, roundTrips: 6, transactions: 1, queries: 3,
    rows: 40, requestId: "must-not-be-written",
  };
  recordPostgresSessionObservation(env, summary);
  assert.deepEqual(written[0], {
    indexes: [POSTGRES_OBSERVABILITY_SCHEMA],
    blobs: [
      "session", "postgres.catalog", "session", "shard-0", "ok", "none", "version-1",
      "cache_disabled", "none", "slow", "channel-catalog.page",
    ],
    doubles: [812, 40, 1, 1, ...SESSION_SEGMENTS.map((field) => summary[field])],
  });
  assert.equal(written[0].doubles.length, 15);
  assert.equal(JSON.stringify(written).includes("must-not-be-written"), false);

  recordPostgresSessionObservation(env, { ...summary, wallMs: 20, outcome: "error",
    errorCode: "CONNECTION_TERMINATED", roundTrips: -1 });
  assert.deepEqual(written[1].blobs.slice(4, 6), ["error", "CONNECTION_TERMINATED"]);
  assert.equal(written[1].doubles[3], 1);
  assert.equal(written[1].doubles[12], 0, "a negative round-trip count is not written");

  // Fast business rollbacks are ordinary traffic and thinned like successes.
  for (let i = 0; i < 200; i += 1) {
    recordPostgresSessionObservation(env, { ...summary, wallMs: 20, outcome: "rollback" });
  }
  const rollbacks = written.slice(2);
  assert.ok(rollbacks.length < 5);
  for (const point of rollbacks) {
    assert.deepEqual(point.blobs.slice(4, 6), ["rollback", "none"]);
    assert.equal(point.doubles[3], 10_000);
  }
});

test("database observers accept any Worker env and stay silent without the binding", () => {
  const { env, written } = sink({ POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE: "1" });
  const observers = postgresDatabaseObservers(env);
  observers.observer({ requestId: "r", operation: "space.get", queryName: "space_get_v1",
    shardId: "shard-0", durationMs: 1, rowCount: 1, outcome: "ok", slow: false });
  observers.sessionObserver({ operation: "space.get", shardId: "shard-0", outcome: "ok",
    wallMs: 3, queueMs: 0, checkoutMs: 0, firstStatementMs: 1, beginMs: 1,
    sqlMs: 1, sqlMaxMs: 1, commitMs: 1, rollbackMs: 0, roundTrips: 4, transactions: 1,
    queries: 1, rows: 1 });
  assert.deepEqual(written.map((point) => point.blobs[0]), ["query", "session"]);
  assert.doesNotThrow(() => postgresDatabaseObservers({}).observer({ requestId: "r",
    operation: "space.get", queryName: "space_get_v1", shardId: "shard-0", durationMs: 1,
    rowCount: 1, outcome: "error", slow: false }));
});

test("connection failures receive a request-level point and observation remains best effort", () => {
  const { env, written } = sink();
  recordPostgresReadinessSummary({
    env,
    shardId: "shard-0",
    outcome: "error",
    durationMs: 17,
    errorCode: "ECONNRESET",
  });
  assert.deepEqual(written[0], {
    indexes: [POSTGRES_OBSERVABILITY_SCHEMA],
    blobs: [
      "readiness", "postgres.readiness", "none", "shard-0",
      "error", "ECONNRESET", "version-1", "cache_disabled", "none", "all", "none",
    ],
    doubles: [17, 0, 0, 1],
  });
  assert.doesNotThrow(() => recordPostgresReadinessSummary({
    env: sink({ RELAY_AUTHORITY_OBSERVABILITY_AE: { writeDataPoint: () => { throw new Error("down"); } } }).env,
    shardId: "shard-0",
    outcome: "ok",
    durationMs: 1,
  }));
});

test("message coordination keeps one privacy-safe point with every phase", () => {
  const { env, written } = sink({ POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE: "1" });
  assert.equal(recordMessageCoordination({
    env, outcome: "ok",
    durations: {
      routeMs: 1, prepareMs: 2, reserveMs: 3, encodeMs: 4,
      appendMs: 5, confirmMs: 6, totalMs: 21,
    },
  }), true);
  assert.deepEqual(written, [{
    indexes: [POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA],
    blobs: ["message_append", "ok", "NONE", "version-1", "sampled"],
    doubles: [1, 2, 3, 4, 5, 6, 21, 1],
  }]);
  assert.equal(JSON.stringify(written).includes("space-"), false);
});

test("message coordination always retains errors and cleanup has bounded dimensions", () => {
  const { env, written } = sink({ POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE: "10000" });
  assert.equal(recordMessageCoordination({
    env, outcome: "error", errorCode: "secret=password",
    durations: {
      routeMs: 1, prepareMs: Number.NaN, reserveMs: 0, encodeMs: 0,
      appendMs: 7, confirmMs: 0, totalMs: 8,
    },
  }), true);
  recordChannelReservationCleanup({
    env, outcome: "ok", deleted: 256, remaining: 3, oldestAgeMs: 42, durationMs: 5,
  });
  assert.deepEqual(written[0].blobs, [
    "message_append", "error", "NONE", "version-1", "error",
  ]);
  assert.deepEqual(written[0].doubles, [1, 0, 0, 0, 7, 0, 8, 1]);
  assert.deepEqual(written[1], {
    indexes: [POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA],
    blobs: ["channel_reservation_cleanup", "ok", "none", "version-1", "all"],
    doubles: [256, 3, 42, 5, 1],
  });
});

test("Launch coordinator points retain actionable backlog timings", () => {
  const { env, written } = sink();
  recordAgentLaunchCoordinator({
    env, outcome: "ok", preparedToWakeMs: 11, wakeToClaimMs: 12,
    claimBatchSize: 3, eligibleCount: 4, oldestEligibleAgeMs: 13, maintainMs: 14,
  });
  assert.deepEqual(written[0], {
    indexes: [POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA],
    blobs: ["agent_launch_maintain", "ok", "none", "version-1", "all"],
    doubles: [11, 12, 3, 4, 13, 14, 1],
  });
});

import { analyticsPointDuration as safeDuration } from "./analytics-sampling";
import type {
  DatabaseObservation,
  DatabaseObserver,
  DatabaseSessionObservation,
  DatabaseSessionObserver,
} from "@xmatrix/db";

import type { Env } from "./types";

/**
 * Every point shares blobs 1-11 and doubles 1-4 (duration, rows, slow, weight),
 * so one weighted quantile query covers any kind. Blob 11 is the code-defined
 * operation the family in blob 2 was derived from. Session points add doubles
 * 5-15 in SESSION_SEGMENTS order.
 */
export const POSTGRES_OBSERVABILITY_SCHEMA = "postgres_substrate_observability_v4";

export type PostgresObservabilityEnv = Pick<Env,
  "RELAY_AUTHORITY_OBSERVABILITY_AE" | "RELAY_AUTHORITY_OBSERVABILITY_ENABLED" |
  "CF_VERSION_METADATA" | "POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE" |
  "POSTGRES_SESSION_OBSERVABILITY_SAMPLE_RATE">;

const DEFAULT_QUERY_SAMPLE_RATE = 10;
const DEFAULT_SESSION_SAMPLE_RATE = 1;
const MAX_SAMPLE_RATE = 10_000;
const SLOW_SESSION_MS = 500;
const QUERY_NAME = /^[a-z][a-z0-9_]{0,95}$/u;
/** Operations are code-defined dotted names; anything else is "other". */
const OPERATION_NAME = /^[a-z][a-z0-9_.:-]{0,119}$/u;
/** Leading segments of code-defined operation names; anything else is "other". */
const OPERATION_FAMILIES = new Set([
  "admin", "agent", "agent-profile", "app", "assistant-memory", "automation", "billing",
  "billing-checkout", "channel", "channel-catalog", "content", "cross-space-read", "decision",
  "governance", "human-profile", "launch", "machine",
  "machine-control", "machine-lifecycle", "machine-request",
  "membership", "message", "page", "postgres", "preference-canary",
  "projection-recovery", "registration", "reply-recovery", "role", "runtime", "scheduler",
  "secret-broker", "secret-value", "shared-memory", "slack-oauth", "space", "space-invite",
  "space-join", "space-join-request", "space-placement", "trace-access", "transfer",
  "user-preference", "workspace",
]);

const OUTCOMES = new Set(["ok", "error", "row_limit"]);
const SHARD_ID = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u;
const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/u;
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "QUERY_READ_TIMEOUT",
  "DATABASE_ERROR",
  "DATABASE_ROW_LIMIT_EXCEEDED",
  "BINDING_UNAVAILABLE",
  "CONNECTION_TERMINATED",
  "CONNECTION_UNUSABLE",
  "CONNECT_TIMEOUT",
  "DATABASE_CONTRACT_ERROR",
]);
const AGENT_LAUNCH_STAGES = new Set([
  "message_commit_to_interpret", "launch_resolve", "launch_prepare", "directory_publish",
  "command_issue", "reverse_wake", "daemon_claim", "daemon_admit", "daemon_spawn",
  "instance_connect", "first_reply_append",
]);

function version(env: PostgresObservabilityEnv): string {
  return env.CF_VERSION_METADATA?.id?.trim().slice(0, 40) || "unknown";
}


function safeErrorCode(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase();
  return normalized && (POSTGRES_SQLSTATE.test(normalized) || TRANSIENT_ERROR_CODES.has(normalized))
    ? normalized
    : "DATABASE_ERROR";
}

function safeRowCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function operationStage(value: string): string {
  if (value === "postgres.readiness") return "postgres.readiness";
  if (value.startsWith("channel-catalog.page")) return "postgres.catalog";
  if (value.startsWith("channel-catalog.resolve")) return "postgres.resolve";
  if (value.startsWith("message.history")) return "postgres.history";
  if (value.startsWith("channel.direct-find")) return "postgres.direct";
  if (value.startsWith("message.")) return "postgres.message";
  if (value.startsWith("agent-profile.launch.")) return "postgres.launch";
  if (value.startsWith("runtime.summon") || value.startsWith("runtime.agent-launch") ||
      value.startsWith("launch.")) return "postgres.launch";
  if (value.startsWith("runtime.instance_connect")) return "postgres.instance-connect";
  if (value.startsWith("runtime.machine-lifecycle")) return "postgres.machine-lifecycle";
  if (value.startsWith("runtime.")) return "postgres.runtime";
  if (value.startsWith("machine.") || value.startsWith("machine-control.")) return "postgres.machine";
  const family = value.split(".", 1)[0] ?? "";
  return OPERATION_FAMILIES.has(family) ? `postgres.${family}` : "other";
}

function queryStage(rawOperation: string, operation: string, queryName: string): string {
  if (operation === "postgres.readiness" && queryName === "postgres_health_v1") {
    return "postgres_health_v1";
  }
  const phase = /^database_phase_(pool_checkout|begin|configure|commit|rollback)_v1$/u
    .exec(queryName);
  if (phase) return `phase.${phase[1]}`;
  if (rawOperation.startsWith("agent-profile.launch.")) return "launch_resolve";
  if (rawOperation.startsWith("runtime.summon") &&
      (queryName.startsWith("runtime_summon_v2_profiles_exact_") ||
       queryName.startsWith("runtime_summon_v2_workspaces_exact_"))) return "launch_resolve";
  if (rawOperation.startsWith("runtime.summon")) return "launch_prepare";
  if (rawOperation.startsWith("launch.directory-publish") ||
      rawOperation.startsWith("launch.directory_publish.")) return "directory_publish";
  if (rawOperation === "machine-control.issue" ||
      rawOperation === "machine-control.issue_batch") return "command_issue";
  if (rawOperation === "machine-control.claim") return "daemon_claim";
  if (rawOperation.startsWith("runtime.machine-lifecycle.machine_spawn_result")) return "daemon_spawn";
  if (rawOperation.startsWith("runtime.instance_connect")) return "instance_connect";
  if (operation === "postgres.catalog" && queryName.startsWith("channel_catalog_")) {
    return "catalog.sql";
  }
  if (operation === "postgres.resolve" && queryName.startsWith("channel_catalog_")) {
    return "resolve.sql";
  }
  if (operation === "postgres.history" && queryName.startsWith("message_")) {
    return "history.sql";
  }
  if (operation === "postgres.message" && queryName.startsWith("message_")) {
    return "message.sql";
  }
  if (operation === "postgres.direct" && queryName.startsWith("channel_direct_")) {
    return "direct.sql";
  }
  if (operation === "postgres.launch" && (queryName.startsWith("runtime_summon_") ||
      queryName.startsWith("runtime_agent_launch_") || queryName.startsWith("agent_launch_"))) {
    return "launch.sql";
  }
  if (operation === "postgres.instance-connect" && queryName.startsWith("runtime_instance_connect_")) {
    return "instance_connect.sql";
  }
  if (operation === "postgres.machine-lifecycle" && queryName.startsWith("machine_lifecycle_")) {
    return "machine_lifecycle.sql";
  }
  if (operation === "postgres.runtime" && queryName.startsWith("runtime_")) return "runtime.sql";
  if (operation === "postgres.machine" && queryName.startsWith("machine_")) return "machine.sql";
  return operation === "other" ? "other" : "sql";
}

function sampleRate(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/u.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_SAMPLE_RATE ? parsed : fallback;
}

/**
 * Errors and slow work are always kept at weight one; ordinary successes are
 * kept one in `rate` and carry weight `rate`, so weighted quantiles stay
 * unbiased while write volume scales with requests, not with round trips.
 */
function retention(rate: number, outcome: string, slow: boolean): { reason: string; weight: number } | null {
  if (outcome !== "ok") return { reason: "error", weight: 1 };
  if (slow) return { reason: "slow", weight: 1 };
  if (rate === 1) return { reason: "all", weight: 1 };
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return value % rate === 0 ? { reason: "sampled", weight: rate } : null;
}

function operationName(value: string): string {
  return OPERATION_NAME.test(value) && OPERATION_FAMILIES.has(value.split(".", 1)[0] ?? "") ? value : "other";
}

function shard(value: string | null | undefined): string {
  return value && SHARD_ID.test(value) ? value : "other";
}

function write(env: PostgresObservabilityEnv, point: AnalyticsEngineDataPoint): void {
  if (env.RELAY_AUTHORITY_OBSERVABILITY_ENABLED !== "true") return;
  try {
    env.RELAY_AUTHORITY_OBSERVABILITY_AE?.writeDataPoint(point);
  } catch {
    // PostgreSQL observation is derived state and cannot affect readiness.
  }
}

/** Query-level observation. SQL, parameters, results, credentials, and request ids never cross this boundary. */
export function recordPostgresQueryObservation(
  env: PostgresObservabilityEnv,
  input: DatabaseObservation,
): void {
  const operation = operationStage(input.operation);
  const stage = queryStage(input.operation, operation, input.queryName);
  const outcome = OUTCOMES.has(input.outcome) ? input.outcome : "error";
  const kept = retention(
    sampleRate(env.POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE, DEFAULT_QUERY_SAMPLE_RATE),
    outcome,
    input.slow,
  );
  if (!kept) return;
  write(env, {
    indexes: [POSTGRES_OBSERVABILITY_SCHEMA],
    blobs: [
      "query",
      operation,
      stage,
      shard(input.shardId),
      outcome,
      input.errorCode ? safeErrorCode(input.errorCode) : "none",
      version(env),
      "cache_disabled",
      QUERY_NAME.test(input.queryName) ? input.queryName : "other",
      kept.reason,
      operationName(input.operation),
    ],
    doubles: [
      safeDuration(input.durationMs), safeRowCount(input.rowCount), input.slow ? 1 : 0, kept.weight,
    ],
  });
}

/** Doubles 5-15 of a session point, in order. */
export const SESSION_SEGMENTS = [
  "queueMs", "checkoutMs", "firstStatementMs", "beginMs", "sqlMs", "sqlMaxMs",
  "commitMs", "rollbackMs", "roundTrips", "transactions", "queries",
] as const satisfies readonly (keyof DatabaseSessionObservation)[];

/**
 * One point per connection checkout: the request-level view of database time.
 * p95/p99 of `wallMs` with its segments answers whether a tail came from
 * waiting for a connection, an origin connection, or SQL, in one row.
 */
export function recordPostgresSessionObservation(
  env: PostgresObservabilityEnv,
  input: DatabaseSessionObservation,
): void {
  const wallMs = safeDuration(input.wallMs);
  const slow = wallMs >= SLOW_SESSION_MS;
  const outcome = input.outcome === "ok" || input.outcome === "rollback" ? input.outcome : "error";
  // A business rollback is ordinary traffic: it is thinned like a success.
  const kept = retention(
    sampleRate(env.POSTGRES_SESSION_OBSERVABILITY_SAMPLE_RATE, DEFAULT_SESSION_SAMPLE_RATE),
    outcome === "error" ? "error" : "ok",
    slow,
  );
  if (!kept) return;
  write(env, {
    indexes: [POSTGRES_OBSERVABILITY_SCHEMA],
    blobs: [
      "session",
      operationStage(input.operation),
      "session",
      shard(input.shardId),
      outcome,
      input.errorCode ? safeErrorCode(input.errorCode) : "none",
      version(env),
      "cache_disabled",
      "none",
      kept.reason,
      operationName(input.operation),
    ],
    doubles: [
      wallMs, safeRowCount(input.rows), slow ? 1 : 0, kept.weight,
      ...SESSION_SEGMENTS.map((field) => field === "roundTrips" || field === "transactions" ||
        field === "queries" ? safeRowCount(input[field]) : safeDuration(input[field])),
    ],
  });
}

/**
 * Observers for an authority database; every production PostgreSQL client
 * installs them. Authorities type their env narrowly, but the Worker env they
 * receive carries the observability bindings, which stay optional here.
 */
export function postgresDatabaseObservers(workerEnv: object): {
  observer: DatabaseObserver;
  sessionObserver: DatabaseSessionObserver;
} {
  const env = workerEnv as PostgresObservabilityEnv;
  return {
    observer: (observation) => recordPostgresQueryObservation(env, observation),
    sessionObserver: (observation) => recordPostgresSessionObservation(env, observation),
  };
}

/** Request-level summary also covers connection and transaction failures that occur before a SQL query runs. */
export function recordPostgresReadinessSummary(input: {
  env: PostgresObservabilityEnv;
  shardId: string;
  outcome: "ok" | "error";
  durationMs: number;
  errorCode?: string;
}): void {
  write(input.env, {
    indexes: [POSTGRES_OBSERVABILITY_SCHEMA],
    blobs: [
      "readiness",
      "postgres.readiness",
      "none",
      SHARD_ID.test(input.shardId) ? input.shardId : "other",
      input.outcome,
      input.errorCode ? safeErrorCode(input.errorCode) : "none",
      version(input.env),
      "cache_disabled",
      "none",
      "all",
      "none",
    ],
    doubles: [safeDuration(input.durationMs), 0, 0, 1],
  });
}

/** Low-cardinality lifecycle timing; business identities stay in bounded logs, never AE labels. */
export function recordAgentLaunchStage(input: { env: PostgresObservabilityEnv; stage: string; outcome: "ok" | "error";
  durationMs: number; shardId?: string; errorCode?: string }): void {
  if (!AGENT_LAUNCH_STAGES.has(input.stage)) return;
  write(input.env, { indexes: [POSTGRES_OBSERVABILITY_SCHEMA], blobs: [
    "agent_launch_stage", "postgres.launch", input.stage,
    input.shardId && SHARD_ID.test(input.shardId) ? input.shardId : "other",
    input.outcome, input.errorCode ? safeErrorCode(input.errorCode) : "none",
    version(input.env), "cache_disabled", "none", "all", "none",
  ], doubles: [safeDuration(input.durationMs), 0, 0, 1] });
}

import { parsePostgresLockWait, type PostgresLockWait } from "./postgres-lock-wait.js";

/** Metadata-only failures. Never retain SQL, parameters, caller IDs or driver messages. */
export interface DatabaseFailureEvidence {
  operation: string;
  shardId: string;
  statement: "single_read" | "transaction";
  phase: "pool_checkout" | "begin" | "sql" | "commit" | "rollback";
  queryName: string;
  code: string;
  durationMs: number;
  lockWait?: PostgresLockWait;
  queryWait?: PostgresLockWait;
  /** Cumulative session progress at this failure, before rollback or retry. */
  session?: Readonly<Record<"wallMs" | "queueMs" | "checkoutMs" | "beginMs" | "sqlMs" |
    "sqlMaxMs" | "commitMs" | "roundTrips" | "queries", number>>;
}
const failures = new WeakMap<object, readonly DatabaseFailureEvidence[]>();
const LIMIT = 4;
const FIELDS = ["operation", "shardId", "statement", "phase", "queryName", "code", "durationMs"];
const SESSION_FIELDS = ["wallMs", "queueMs", "checkoutMs", "beginMs", "sqlMs", "sqlMaxMs",
  "commitMs", "roundTrips", "queries"] as const;
const CODES = new Set(["QUERY_READ_TIMEOUT", "CONNECTION_TERMINATED", "CONNECTION_UNUSABLE", "CONNECT_TIMEOUT",
  "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "EPIPE", "ETIMEDOUT", "DATABASE_CIRCUIT_OPEN",
  "DATABASE_CONTRACT_ERROR", "DATABASE_ERROR"]);

/** The connector reads this exact bounded projection, never arbitrary event extras. */
export function parseDatabaseFailureEvidence(value: unknown): readonly DatabaseFailureEvidence[] {
  if (!Array.isArray(value) || value.length > LIMIT) return [];
  const result: DatabaseFailureEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Object.keys(item).length !== FIELDS.length + ("session" in item ? 1 : 0) + ("lockWait" in item ? 1 : 0) + ("queryWait" in item ? 1 : 0) ||
        Object.keys(item).some(key => key !== "session" && key !== "lockWait" && key !== "queryWait" && !FIELDS.includes(key)) ||
        typeof item.operation !== "string" || !/^[a-z][a-z0-9_.:-]{0,119}$/u.test(item.operation) ||
        typeof item.shardId !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,79}$/u.test(item.shardId) ||
        !["single_read", "transaction"].includes(item.statement) ||
        !["pool_checkout", "begin", "sql", "commit", "rollback"].includes(item.phase) ||
        typeof item.queryName !== "string" || !/^[a-z][a-z0-9_]{0,159}$/u.test(item.queryName) ||
        typeof item.code !== "string" || !(CODES.has(item.code) || /^[0-9A-Z]{5}$/u.test(item.code)) ||
        !Number.isSafeInteger(item.durationMs) || item.durationMs < 0 || item.durationMs > 120_000) return [];
    const session = "session" in item ? parseSession(item.session) : undefined;
    if (session === null) return [];
    const lockWait = "lockWait" in item ? parsePostgresLockWait(item.lockWait) : undefined;
    if ("lockWait" in item && !lockWait) return [];
    const queryWait = "queryWait" in item ? parsePostgresLockWait(item.queryWait) : undefined;
    if ("queryWait" in item && !queryWait) return [];
    result.push(Object.freeze({ operation: item.operation, shardId: item.shardId, statement: item.statement,
      phase: item.phase, queryName: item.queryName, code: item.code, durationMs: item.durationMs,
      ...(session ? { session } : {}), ...(lockWait ? { lockWait } : {}), ...(queryWait ? { queryWait } : {}) }));
  }
  return Object.freeze(result);
}

function parseSession(value: unknown): DatabaseFailureEvidence["session"] | null {
  if (!value || typeof value !== "object" || Object.keys(value).length !== SESSION_FIELDS.length ||
      Object.keys(value).some(key => !SESSION_FIELDS.includes(key as typeof SESSION_FIELDS[number]))) return null;
  const session = value as NonNullable<DatabaseFailureEvidence["session"]>;
  if (SESSION_FIELDS.some(key => !Number.isSafeInteger(session[key]) || session[key] < 0 || session[key] > 120_000)) return null;
  return Object.freeze({ ...session });
}

export function recordDatabaseFailure(error: unknown, evidence: DatabaseFailureEvidence): void {
  if (!error || typeof error !== "object") return;
  const code = evidence.code.toUpperCase();
  const safe = parseDatabaseFailureEvidence([{ ...evidence,
    code: CODES.has(code) || /^[0-9A-Z]{5}$/u.test(code) ? code : "DATABASE_ERROR",
    durationMs: Math.min(120_000, Math.max(0, Math.round(evidence.durationMs))),
    ...(evidence.session ? { session: Object.fromEntries(SESSION_FIELDS.map(key =>
      [key, Math.min(120_000, Math.max(0, Math.round(evidence.session![key]))) ])) } : {}) }]);
  if (safe.length) failures.set(error, safe);
}

/** Follow only Error causes and aggregate children, with cycle and size bounds. */
export function databaseFailureEvidence(error: unknown): readonly DatabaseFailureEvidence[] {
  const seen = new Set<object>();
  const visit = (value: unknown): readonly DatabaseFailureEvidence[] => {
    if (!(value instanceof Error) || seen.has(value) || seen.size >= 16) return [];
    seen.add(value);
    const own = failures.get(value);
    if (own) return own;
    return (value instanceof AggregateError ? value.errors.slice(0, LIMIT).flatMap(visit) : visit(value.cause)).slice(-LIMIT);
  };
  return visit(error);
}

/** A retry keeps the failed first attempt when its fresh attempt also fails. */
export function linkDatabaseFailures(error: unknown, previous: unknown, latest: unknown = error): void {
  if (!error || typeof error !== "object" || (error === previous && latest === error)) return;
  const combined = [...databaseFailureEvidence(previous), ...databaseFailureEvidence(latest)].slice(-LIMIT);
  if (combined.length) failures.set(error, Object.freeze(combined));
}

/** Metadata-only failures. Never retain SQL, parameters, caller IDs or driver messages. */
export interface DatabaseFailureEvidence {
  operation: string;
  shardId: string;
  statement: "single_read" | "transaction";
  phase: "pool_checkout" | "begin" | "sql" | "commit" | "rollback";
  queryName: string;
  code: string;
  durationMs: number;
}
const failures = new WeakMap<object, readonly DatabaseFailureEvidence[]>();
const LIMIT = 4;
const FIELDS = ["operation", "shardId", "statement", "phase", "queryName", "code", "durationMs"];
const CODES = new Set(["QUERY_READ_TIMEOUT", "CONNECTION_TERMINATED", "CONNECTION_UNUSABLE", "CONNECT_TIMEOUT",
  "ECONNRESET", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "EPIPE", "ETIMEDOUT", "DATABASE_CIRCUIT_OPEN",
  "DATABASE_CONTRACT_ERROR", "DATABASE_ERROR"]);

/** The connector reads this exact bounded projection, never arbitrary event extras. */
export function parseDatabaseFailureEvidence(value: unknown): readonly DatabaseFailureEvidence[] {
  if (!Array.isArray(value) || value.length > LIMIT) return [];
  const result: DatabaseFailureEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Object.keys(item).length !== FIELDS.length ||
        Object.keys(item).some(key => !FIELDS.includes(key)) ||
        typeof item.operation !== "string" || !/^[a-z][a-z0-9_.:-]{0,119}$/u.test(item.operation) ||
        typeof item.shardId !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,79}$/u.test(item.shardId) ||
        !["single_read", "transaction"].includes(item.statement) ||
        !["pool_checkout", "begin", "sql", "commit", "rollback"].includes(item.phase) ||
        typeof item.queryName !== "string" || !/^[a-z][a-z0-9_]{0,159}$/u.test(item.queryName) ||
        typeof item.code !== "string" || !(CODES.has(item.code) || /^[0-9A-Z]{5}$/u.test(item.code)) ||
        !Number.isSafeInteger(item.durationMs) || item.durationMs < 0 || item.durationMs > 120_000) return [];
    result.push(Object.freeze({ operation: item.operation, shardId: item.shardId, statement: item.statement,
      phase: item.phase, queryName: item.queryName, code: item.code, durationMs: item.durationMs }));
  }
  return Object.freeze(result);
}

export function recordDatabaseFailure(error: unknown, evidence: DatabaseFailureEvidence): void {
  if (!error || typeof error !== "object") return;
  const code = evidence.code.toUpperCase();
  const safe = parseDatabaseFailureEvidence([{ ...evidence,
    code: CODES.has(code) || /^[0-9A-Z]{5}$/u.test(code) ? code : "DATABASE_ERROR",
    durationMs: Math.min(120_000, Math.max(0, Math.round(evidence.durationMs))) }]);
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

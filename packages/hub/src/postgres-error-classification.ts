const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "DATABASE_COMMIT_UNKNOWN",
  // The shard's connectivity breaker refused before any PostgreSQL work.
  "DATABASE_CIRCUIT_OPEN",
]);

/** Seconds a client should wait before replaying a retryable PostgreSQL failure. */
const DEFAULT_RETRY_AFTER_SECONDS = 2;
const MAX_RETRY_AFTER_SECONDS = 30;

/** `Retry-After` for a retryable failure: the breaker's own cooldown when it refused. */
export function postgresRetryAfterSeconds(error: unknown): number {
  const retryAfterMs = error && typeof error === "object" && "retryAfterMs" in error
    ? Number((error as { retryAfterMs: unknown }).retryAfterMs) : NaN;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(Math.ceil(retryAfterMs / 1_000), 1), MAX_RETRY_AFTER_SECONDS);
}

const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);
const RETRYABLE_CAPACITY_CODES = new Set(["53300", "57P03"]);
const TIMEOUT_MESSAGE = /(?:statement|lock|query|connection|transaction).*timeout|timeout.*(?:statement|lock|query|connection|transaction)/iu;

function errorField(error: unknown, field: "code" | "message"): string {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * PostgreSQL failures are non-retryable unless the driver provides positive evidence that a
 * replay can succeed. In particular, SQLSTATE class 42 is a code/schema defect, never an outage.
 */
export function retryablePostgresFailure(error: unknown): boolean {
  const rawCode = errorField(error, "code");
  const code = rawCode.toUpperCase();
  // pg emits these exact transport failures as plain Error objects, without a
  // SQLSTATE. Never let message matching override an explicit database code.
  // pg-pool wraps a checkout that hit connectionTimeoutMillis as
  // "Connection terminated due to connection timeout" (cause: the socket
  // "Connection terminated unexpectedly") or, when the pool is already full,
  // "timeout exceeded when trying to connect".
  if (!code && [
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "Query read timeout",
  ].includes(errorField(error, "message"))) return true;
  if (RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (/^08[0-9A-Z]{3}$/u.test(code)) return true;
  if (RETRYABLE_TRANSACTION_CODES.has(code) || RETRYABLE_CAPACITY_CODES.has(code)) return true;
  if ((code === "57014" || code === "55P03") &&
      TIMEOUT_MESSAGE.test(errorField(error, "message"))) return true;
  return false;
}

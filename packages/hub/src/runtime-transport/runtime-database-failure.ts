import { databaseFailureEvidence } from "@xmatrix/db";
import { reportError } from "@xmatrix/protocol/error-reporting";
import { serverCodeFailure } from "../server-code-failure";

// Exact provider-defined messages only; a SQLSTATE alone cannot distinguish
// these failures. https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/
const PROVIDER_REASONS = new Map([
  ["Internal error.", "hyperdrive_internal"],
  ["Failed to acquire a connection from the pool.", "hyperdrive_pool_acquire"],
  ["Server connection attempt failed: connection_refused", "hyperdrive_connection_refused"],
]);

/** The connector exposes only this finite diagnosis, never driver text. */
export function runtimeDatabaseFailureMetadata(value: unknown): string[] {
  return typeof value === "string" && (value === "unclassified" || [...PROVIDER_REASONS.values()].includes(value))
    ? [`Runtime database reason: ${value}`] : [];
}

/**
 * Keep the database client's content-free evidence and deployed code locations.
 * A driver error's message, cause, detail and arbitrary stack text may contain
 * SQL, parameters or credentials; none belongs in a runtime session report.
 */
export function reportRuntimeDatabaseFailure(error: unknown, diagnosticId: string): boolean {
  const attempts = databaseFailureEvidence(error);
  if (!attempts.length) return false;
  const code = attempts.at(-1)!.code;
  const reason = code === "58000" && error instanceof Error
    ? PROVIDER_REASONS.get(error.message) ?? "unclassified" : "unclassified";
  // Workers run the uploaded index.js bundle. Only its numeric locations and
  // static function names may survive, so source maps retain the failing path
  // without copying the driver's headline or multiline SQL diagnostics.
  const failure = serverCodeFailure(error, "RuntimeDatabaseFailure", `Runtime database operation failed (${code}; ${reason})`);
  reportError(failure, { operation: "runtime.database", fingerprint: ["{{ default }}", code, reason], ids: {
    diagnosticId, database_failure_attempts: JSON.stringify(attempts), runtime_database_reason: reason,
  } });
  return true;
}

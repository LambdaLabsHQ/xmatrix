import { databaseFailureEvidence } from "@xmatrix/db";
import { reportError } from "@xmatrix/protocol/error-reporting";

/** One explicit report retains the task even when a platform Error has no origin stack. */
export function scheduledTaskFailed(name: string, error: unknown): void {
  const attempts = databaseFailureEvidence(error);
  reportError(error, { operation: `scheduled: ${name}`, ids: attempts.length ? { database_failure_attempts: JSON.stringify(attempts) } : {} });
  // reportError owns the Sentry event. Logging it again at error level would
  // capture a second event with neither the task tag nor its attempt evidence.
  console.warn(`${name} failed`, error, { databaseFailureAttempts: attempts });
}

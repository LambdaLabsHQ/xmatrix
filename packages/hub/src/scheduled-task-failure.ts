import { databaseFailureEvidence } from "@xmatrix/db";
import { reportError } from "@xmatrix/protocol/error-reporting";
import { HarnessReleaseWatchFailure } from "./harness-release-watch-failure";

/** One explicit report retains the task even when a platform Error has no origin stack. */
export function scheduledTaskFailed(name: string, error: unknown): void {
  const attempts = databaseFailureEvidence(error);
  reportError(error, { operation: `scheduled: ${name}`,
    ...(error instanceof HarnessReleaseWatchFailure ? { fingerprint: ["{{ default }}", "harness-release-watch", error.evidence.phase] } : {}),
    ids: {
      ...(attempts.length ? { database_failure_attempts: JSON.stringify(attempts) } : {}),
      ...(error instanceof HarnessReleaseWatchFailure ? { harness_release_watch_failure: JSON.stringify(error.evidence) } : {}),
    } });
  // reportError owns the Sentry event. Logging it again at error level would
  // capture a second event with neither the task tag nor its attempt evidence.
  console.warn(`${name} failed`, error, { databaseFailureAttempts: attempts });
}

import { linkDatabaseFailures } from "./database-failure-evidence.js";
import { lostBeforeCommit } from "./client.js";

/**
 * Only for database-only work: its owner closes the failed session before
 * this one replay takes a fresh checkout. COMMIT/PREPARE uncertainty and
 * answered database errors still escape to the caller's reconciliation.
 */
export async function retryBeforeCommit<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!lostBeforeCommit(error)) throw error;
    try { return await run(); }
    catch (retryError) { linkDatabaseFailures(retryError, error); throw retryError; }
  }
}

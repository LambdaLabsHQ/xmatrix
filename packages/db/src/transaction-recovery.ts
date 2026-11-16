import { linkDatabaseFailures } from "./database-failure-evidence.js";
import { lostBeforeCommit } from "./client.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";

/** A server-answered lock timeout has already aborted the transaction, so a
 * database-only command may run again exactly like one whose response was lost. */
function lockTimedOut(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    String((error as { code?: unknown }).code).toUpperCase() === "55P03";
}

/**
 * Only for database-only work: its owner closes the failed session before
 * this one replay takes a fresh checkout. COMMIT/PREPARE uncertainty and
 * other answered database errors still escape to the caller's reconciliation;
 * a lock timeout is replayed because the server rolled the transaction back.
 */
export async function retryBeforeCommit<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!lostBeforeCommit(error) && !lockTimedOut(error)) throw error;
    try { return await run(); }
    catch (retryError) { linkDatabaseFailures(retryError, error); throw retryError; }
  }
}

/** Database-only commands own a fresh session per attempt, even when given a request session. */
export function retryTransactionBeforeCommit<T>(database: AuthorityDatabase, context: DatabaseRequestContext,
  callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return retryBeforeCommit(async () => {
    const session = database.openSession();
    try { return await session.transaction(context, callback); }
    finally { await session.close(); }
  });
}

import { linkDatabaseFailures } from "./database-failure-evidence.js";
import { lostBeforeCommit } from "./client.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";

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

/** Database-only commands own a fresh session per attempt, even when given a request session. */
export function retryTransactionBeforeCommit<T>(database: AuthorityDatabase, context: DatabaseRequestContext,
  callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
  return retryBeforeCommit(async () => {
    const session = database.openSession();
    try { return await session.transaction(context, callback); }
    finally { await session.close(); }
  });
}

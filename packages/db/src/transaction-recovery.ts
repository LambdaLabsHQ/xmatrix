import { linkDatabaseFailures } from "./database-failure-evidence.js";
import { lostBeforeCommit, lockTimeoutBeforeCommit } from "./client.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";

/**
 * Only for database-only work: its owner closes the failed session before
 * this one replay takes a fresh checkout. COMMIT/PREPARE uncertainty and
 * answered database errors still escape to the caller's reconciliation; the
 * one exception a caller may opt into is a lock-deadline abort (`55P03`),
 * which released its locks and committed nothing.
 */
export async function retryBeforeCommit<T>(run: () => Promise<T>,
  options: { lockTimeout?: boolean } = {}): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!lostBeforeCommit(error) && !(options.lockTimeout && lockTimeoutBeforeCommit(error))) throw error;
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
  }, { lockTimeout: true });
}


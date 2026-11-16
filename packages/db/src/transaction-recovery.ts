import { linkDatabaseFailures } from "./database-failure-evidence.js";
import { lostBeforeCommit, lockTimeoutBeforeCommit } from "./client.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";

/**
 * Only for database-only work: its owner closes the failed session before
 * this one replay takes a fresh checkout. COMMIT/PREPARE uncertainty and
 * answered database errors still escape to the caller's reconciliation. A
 * caller may opt into replaying one lock-deadline abort (`55P03`), which
 * released its locks and committed nothing; callers whose rejection is itself
 * the evidence (the Machine scope lock) leave it off.
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

/** Commands whose Channel lock is taken as authority before any write may
 * replay one lock-deadline abort. A command whose rejection is itself the
 * evidence (the Machine scope lock) stays off this list. */
const REPLAY_LOCK_TIMEOUT = new Set(["message.append", "message.system-annotation"]);

/** Database-only commands own a fresh session per attempt, even when given a request session. */
export function retryTransactionBeforeCommit<T>(database: AuthorityDatabase, context: DatabaseRequestContext,
  callback: (transaction: DatabaseTransaction) => Promise<T>,
  options: { lockTimeout?: boolean } = {}): Promise<T> {
  return retryBeforeCommit(async () => {
    const session = database.openSession();
    try { return await session.transaction(context, callback); }
    finally { await session.close(); }
  }, { lockTimeout: options.lockTimeout ?? REPLAY_LOCK_TIMEOUT.has(context.operation) });
}
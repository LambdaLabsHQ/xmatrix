import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";

/**
 * A read-only repository's statements on its request-local session. Each gets
 * the client's bounded lost-response recovery and its own placement fence and
 * snapshot, as with READ COMMITTED, without an enclosing BEGIN or COMMIT.
 * The client rejects writes and locking reads. The caller owns session close.
 */
export function singleReadStatements(database: AuthorityDatabase,
  context: DatabaseRequestContext): DatabaseTransaction {
  return { query: (query) => database.transaction(
    { ...context, statement: "single_read" }, (tx) => tx.query(query)) };
}

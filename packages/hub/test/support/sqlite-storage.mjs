export { sqliteCursor } from "../../scripts/sqlite-cursor.mjs";
import { sqliteCursor } from "../../scripts/sqlite-cursor.mjs";
import { sqliteTransaction } from "../../scripts/sqlite-transaction.mjs";
// A Durable Object SQL storage stand-in over node:sqlite, so Authority and
// relay modules run their real SQL in unit tests without a Worker.

// node:sqlite binds typed arrays, while Durable Object SQL also takes ArrayBuffers.
function sqliteBinding(value) {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]" ? new Uint8Array(value) : value;
}

/**
 * Durable Object storage over one SQLite database. A read or a statement with
 * bindings returns its rows; an unbound write runs as a script, so a schema
 * can be applied in one call.
 */
export function sqliteStorage(database) {
  return {
    sql: {
      exec(statement, ...bindings) {
        if (bindings.length > 0 || /^(?:PRAGMA|SELECT|WITH)\b/iu.test(statement.trim())) {
          return sqliteCursor(database.prepare(statement).all(...bindings.map(sqliteBinding)));
        }
        database.exec(statement);
        return sqliteCursor();
      },
    },
    transactionSync(callback) {
      return sqliteTransaction(database, callback);
    },
  };
}

/** An Authority host whose Durable Object storage is one SQLite database. */
export function sqliteAuthorityHost(database, storage, doEnv = {}, host = {}) {
  return {
    doCtx: { storage },
    doEnv,
    first(statement, ...bindings) {
      return database.prepare(statement).get(...bindings);
    },
    ...host,
  };
}

/** Record the exact statements while executing real SQLite SQL and returning its original row arrays. */
export function recordingSqliteStorage(database, statements) {
  return { sql: { exec(statement, ...bindings) {
    statements.push(statement);
    return database.prepare(statement).all(...bindings);
  } } };
}

/** Run one synchronous SQLite transaction, retaining the caller's result/error. */
export function sqliteTransaction(database, callback) {
  database.exec("BEGIN");
  try {
    const value = callback();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

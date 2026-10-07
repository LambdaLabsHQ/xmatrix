/**
 * A fake authority database for admin read tests: each named query answers
 * from a fixed table (or a function of the query), and every query passes
 * through `inspect` first so a test can assert what SQL is issued.
 */
export function adminQueryDatabase(resultByQuery, inspect = () => {}) {
  return {
    cacheMode: "disabled",
    async transaction(_context, callback) {
      return callback({
        async query(query) {
          if (!Number.isSafeInteger(query.maxRows) || query.maxRows < 0 || query.maxRows > 10_000) {
            throw new Error("query.maxRows must be between 0 and 10000");
          }
          inspect(query);
          if (!(query.name in resultByQuery)) throw new Error(`unexpected query ${query.name}`);
          const result = resultByQuery[query.name];
          return typeof result === "function" ? result(query) : result;
        },
      });
    },
  };
}

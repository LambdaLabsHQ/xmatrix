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

/* Columns that hold user content or private detail. No operator query may name them. */
export const ADMIN_CONTENT_COLUMNS = [
  /\bbody\b/u, /\bmetadata_json\b/u, /\bconfiguration_json\b/u, /\bsecret_refs_json\b/u,
  /\bencrypted_value_json\b/u, /\bcapabilities_json\b/u, /\berror\b/u, /\bhostname\b/u,
  /\bip_address\b/u, /\buser_agent\b/u, /\btitle\b/u, /\btoken\b/u,
];

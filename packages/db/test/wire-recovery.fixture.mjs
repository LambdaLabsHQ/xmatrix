import assert from "node:assert/strict";
import { ConnectivityBreaker, createAuthorityDatabase } from "../dist/index.js";

/** Driver faults exercise real transaction/session ownership, without implementing recovery. */
export function wireRecoveryDatabase(stage, failures, { shardId = "fixture",
  breaker = new ConnectivityBreaker(shardId), phaseForQuery = () => "sql", rowsForQuery = () => [] } = {}) {
  const pools = [];
  const database = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId,
    connectivityBreaker: breaker, poolFactory: () => {
      const index = pools.length;
      const pool = { ended: false, queries: [], releases: [], async connect() {
        assert.ok(pools.slice(0, index).every(previous => previous.ended), "close before a fresh session");
        if (stage === "checkout" && failures[index]) throw failures[index];
        return { async query(input) {
          const text = typeof input === "string" ? input : input.text;
          pool.queries.push(text);
          const phase = text.startsWith("BEGIN;") ? "begin" : text === "COMMIT" ? "commit" : phaseForQuery(text);
          if (phase === stage && failures[index]) {
            const error = failures[index]; failures[index] = undefined; throw error;
          }
          const rows = rowsForQuery(text);
          return { rows, rowCount: rows.length };
        }, release(destroy) { pool.releases.push(destroy); } };
      }, async end() { pool.ended = true; } };
      pools.push(pool);
      return pool;
    } });
  return { database, pools };
}

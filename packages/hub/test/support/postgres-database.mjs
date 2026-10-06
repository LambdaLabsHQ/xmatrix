// PostgreSQL authority database stand-ins: each statement is answered by the
// test, so an authority's SQL contract is exercised without a server.

/** A database whose statements `respond` answers. */
export function authorityDatabase(respond) {
  return {
    cacheMode: "disabled",
    async transaction(context, callback) {
      return callback({ async query(query) { return respond(query, context); } });
    },
  };
}

/** A database whose statements `respond` answers, recording each transaction context and statement in `calls`. */
export function recordingDatabase(respond, calls = []) {
  return {
    calls,
    cacheMode: "disabled",
    async transaction(context, callback) {
      calls.push(context);
      return callback({ async query(query) { calls.push(query); return respond(query); } });
    },
  };
}

/** The placement row of a Space placed, active and shared, on one shard. */
export function activePlacementRow(shardId = "shard-0", spaceId = "space-1") {
  return { space_id: spaceId, shard_id: shardId, placement_epoch: 1, state: "active", target_shard_id: null,
    plan_class: "shared" };
}

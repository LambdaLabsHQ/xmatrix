// An injected AuthorityDatabase for authority unit tests. Each query is
// answered by `respond(query)`; `calls` records every transaction's
// `{ context }` followed by the queries it ran. The database is also its own
// request session, counting opens and closes.
export function recordingDatabase(respond = () => [], {
  cacheMode = "disabled", recordContext = true, checkContext = () => {},
} = {}) {
  const calls = [];
  const session = {
    calls,
    sessionOpens: 0,
    sessionCloses: 0,
    cacheMode,
    async health() { return { ok: true, latencyMs: 1, shardId: "shard-0" }; },
    openSession() { session.sessionOpens += 1; return session; },
    async close() { session.sessionCloses += 1; },
    async transaction(context, callback) {
      checkContext(context);
      if (recordContext) calls.push({ context });
      return callback({ async query(query) { calls.push(query); return respond(query); } });
    },
  };
  return session;
}

/** The placement directory's row for an active Space that is not moving. */
export function activePlacementRow(spaceId = "space-1",
  { shardId = "shard-0", placementEpoch = 1, planClass = "shared" } = {}) {
  return { space_id: spaceId, shard_id: shardId, placement_epoch: placementEpoch, state: "active",
    target_shard_id: null, plan_class: planClass };
}

/** A Space placed on its own shard after moves: the directory row tests route `shard-1` writes by. */
export function dedicatedPlacementRow(spaceId = "space-1") {
  return activePlacementRow(spaceId, { shardId: "shard-1", placementEpoch: 7, planClass: "dedicated" });
}

/**
 * Answers the message authority's placement and Channel capability reads for
 * open Channel `channel-1` in `space-1`, archived at `archivedAt` if given;
 * undefined for any other query.
 */
export function openMessageChannel(query, archivedAt = null) {
  if (query.name === "space_placement_resolve_v1") return [activePlacementRow()];
  if (query.name?.startsWith("channel_capability_message_")) return [{
    channel_id: "channel-1", space_id: "space-1", mode: "open",
    metadata_json: {}, version: 1, archived_at: archivedAt,
  }];
  return undefined;
}

/** Stored text message `message-1` in `channel-1` by user `author-1`, sent and last updated `at`. */
export function storedMessageRow(at, overrides = {}) {
  return {
    message_id: "message-1", channel_id: "channel-1", timeline_sequence: 1,
    entity_version: 1, author_kind: "user", author_id: "author-1",
    message_kind: "xmatrix.message.text", content_hash: "1".repeat(64),
    payload_kind: "hot-inline", payload_ref: "inline", reactions_json: [],
    annotations_json: [], attachments_json: [], sent_at: at,
    edited_at: null, recalled_at: null, deleted_at: null, updated_at: at,
    search_rank_sequence: "pg:1", codec_id: "canonical-clone-cbor-v1",
    payload_schema_version: 1, field_presence_base64: "AA", payload_bundle_base64: "AA",
    body_hash: "2".repeat(64), sender_snapshot_digest: "3".repeat(64),
    record_digest: "4".repeat(64), record_encoded_bytes: 10,
    ...overrides,
  };
}

/**
 * Answers the directory reads that place Channel `channel-1` of `space-1`: its
 * route and its Space's placement, on shard-0 or, when `dedicated`, on the
 * dedicated shard-1. Undefined for any other query.
 */
export function placedChannel(query, { dedicated = false } = {}) {
  const placement = dedicated ? dedicatedPlacementRow() : activePlacementRow();
  if (query.name === "channel_space_directory_resolve_v2") return [{ channel_id: "channel-1", space_id: "space-1",
    shard_id: placement.shard_id, placement_epoch: placement.placement_epoch, entity_version: 4 }];
  if (query.name === "space_placement_resolve_v1") return [placement];
  return undefined;
}

/** An opaque entity resolves to Space 1's dedicated shard. */
export function routedEntityDirectory(route) {
  return recordingDatabase(query => {
    if (query.name === "entity_space_route_resolve_v1") return [route];
    if (query.name === "space_placement_resolve_v1") return [dedicatedPlacementRow()];
    return [];
  });
}

export function publicationPlacement(query) {
  if (query.name === "space_placement_resolve_v1") return [activePlacementRow()];
  if (query.name === "entity_space_route_placement_fence_v1") return [{ shard_id: "shard-0", placement_epoch: 1 }];
  return undefined;
}

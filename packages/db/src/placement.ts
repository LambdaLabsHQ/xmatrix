import type { QueryResultRow } from "pg";

import type { DatabaseRequestContext } from "./context.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { DatabaseContractError } from "./errors.js";
import {
  boundedDatabaseIdentifier,
  databaseTimestamp,
  positiveDatabaseInteger,
} from "./identifiers.js";

export interface SpacePlacement {
  spaceId: string;
  shardId: string;
  placementEpoch: number;
  state: "active" | "moving" | "blocked";
  targetShardId: string | null;
  planClass: string;
}

export interface ChannelSpaceRoute {
  channelId: string;
  spaceId: string;
  shardId: string;
  placementEpoch: number;
  entityVersion: number;
}

export interface ChannelSpaceDirectoryMutation extends ChannelSpaceRoute {
  state: "active" | "deleted";
  updatedAt: string | Date;
}

interface SpacePlacementRow extends QueryResultRow {
  space_id: string;
  shard_id: string;
  placement_epoch: string | number;
  state: string;
  target_shard_id: string | null;
  plan_class: string;
}

function boundedSpaceId(value: unknown): string {
  return boundedDatabaseIdentifier(value, "spaceId");
}

/**
 * Space placements this isolate read from the directory, kept only as routing
 * hints. A placed transaction checks its placement against the shard's own
 * fence before any of its work runs, so a stale hint costs one refused attempt
 * (which drops it), never a read or write on the wrong shard. Only writable
 * placements are kept, so a Space that is moving is always read afresh.
 */
export class SpacePlacementHints {
  private readonly entries = new Map<string, { value: SpacePlacement; expiresAt: number }>();

  constructor(
    private readonly maximumEntries = 4_096,
    private readonly ttlMs = 5 * 60_000,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new DatabaseContractError("Space placement hint bounds are invalid");
    }
  }

  get(spaceId: string): SpacePlacement | undefined {
    const entry = this.entries.get(spaceId);
    if (!entry) return undefined;
    this.entries.delete(spaceId);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(spaceId, entry);
    return entry.value;
  }

  /** Keeps a writable placement; anything else forgets the Space. */
  remember(value: SpacePlacement): void {
    this.entries.delete(value.spaceId);
    if (value.state !== "active" || value.targetShardId !== null) return;
    this.entries.set(value.spaceId, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  forget(spaceId: string): void {
    this.entries.delete(spaceId);
  }
}

function placement(row: SpacePlacementRow): SpacePlacement {
  const placementEpoch = Number(row.placement_epoch);
  if (!Number.isSafeInteger(placementEpoch) || placementEpoch < 1 ||
      (row.state !== "active" && row.state !== "moving" && row.state !== "blocked") ||
      !row.shard_id || !row.plan_class) {
    throw new DatabaseContractError("Space placement row is invalid");
  }
  return Object.freeze({
    spaceId: row.space_id,
    shardId: row.shard_id,
    placementEpoch,
    state: row.state,
    targetShardId: row.target_shard_id,
    planClass: row.plan_class,
  });
}

/**
 * The Spaces an authority writes to. Each write resolves the Space's placement
 * and runs on its shard only while that placement is writable; otherwise it
 * fails with the authority's own `unavailable()` error.
 */
export class WritableSpacePlacements {
  private readonly placements: PostgresSpacePlacementDirectory;

  constructor(private readonly database: AuthorityDatabase, private readonly unavailable: () => Error) {
    this.placements = new PostgresSpacePlacementDirectory(database);
  }

  resolve(requestId: string, operation: string, spaceId: string): Promise<SpacePlacement> {
    return this.placements.resolveWritable({ requestId, operation }, spaceId, this.unavailable);
  }

  /**
   * Runs `work` in one transaction on the shard of `space`: a placement the
   * caller already resolved, or a Space id to resolve now.
   */
  async transaction<T>(requestId: string, operation: string, space: string | SpacePlacement,
    work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    const { spaceId, shardId, placementEpoch } = typeof space === "string"
      ? await this.resolve(requestId, operation, space) : space;
    return this.database.transaction({ requestId, operation, placement: { spaceId, shardId, placementEpoch } }, work);
  }
}

/**
 * Resolves a Space before selecting its physical data connection. In the
 * current one-node topology the directory and shard use the same Hyperdrive;
 * the interface stays separate so a replicated catalog can replace it later.
 */
export class PostgresSpacePlacementDirectory {
  constructor(private readonly directoryDatabase: AuthorityDatabase) {
    if (directoryDatabase.cacheMode !== "disabled") {
      throw new DatabaseContractError("Space placement requires a cache-disabled database");
    }
  }

  async resolve(
    context: Omit<DatabaseRequestContext, "placement">,
    spaceIdValue: string,
  ): Promise<SpacePlacement> {
    const found = await this.find(context, spaceIdValue);
    if (!found) throw new DatabaseContractError("Space placement is unavailable");
    return found;
  }

  /**
   * The Space's placement when its own shard accepts writes: active and not
   * moving to another shard. Otherwise throws `unavailable()`.
   */
  async resolveWritable(
    context: Omit<DatabaseRequestContext, "placement">,
    spaceIdValue: string,
    unavailable: () => Error,
  ): Promise<SpacePlacement> {
    const found = await this.resolve(context, spaceIdValue);
    if (found.state !== "active" || found.targetShardId !== null) throw unavailable();
    return found;
  }

  /**
   * The Space's placement, or null when no such Space exists. A writable
   * placement may come from the fleet's routing hints; the shard's fence
   * confirms it when the placed transaction opens.
   */
  async find(
    context: Omit<DatabaseRequestContext, "placement">,
    spaceIdValue: string,
  ): Promise<SpacePlacement | null> {
    const spaceId = boundedSpaceId(spaceIdValue);
    return this.directoryDatabase.placementHints?.get(spaceId) ?? this.read(context, spaceId);
  }

  /** The directory's current placement, never a hint; refreshes the hints. */
  async read(
    context: Omit<DatabaseRequestContext, "placement">,
    spaceIdValue: string,
  ): Promise<SpacePlacement | null> {
    const spaceId = boundedSpaceId(spaceIdValue);
    const hints = this.directoryDatabase.placementHints;
    const found = await this.directoryDatabase.transaction({
      requestId: context.requestId, operation: context.operation, statement: "single_read",
    }, async (transaction) => {
      const rows = await transaction.query<SpacePlacementRow>({
        name: "space_placement_resolve_v1",
        text: `SELECT space_id, shard_id, placement_epoch, state, target_shard_id, plan_class
          FROM control.space_placement WHERE space_id = $1`,
        values: [spaceId],
        maxRows: 1,
      });
      if (!rows[0]) return null;
      const value = placement(rows[0]);
      if (value.spaceId !== spaceId) throw new DatabaseContractError("Space placement identity differs");
      return value;
    });
    if (found) hints?.remember(found);
    else hints?.forget(spaceId);
    return found;
  }
}

interface ChannelSpaceRouteRow extends QueryResultRow {
  channel_id: string;
  space_id: string;
  shard_id: string;
  placement_epoch: string | number;
  entity_version: string | number;
}

function channelRoute(channelId: string, row: ChannelSpaceRouteRow): ChannelSpaceRoute {
  return Object.freeze({
    channelId,
    spaceId: boundedSpaceId(row.space_id),
    shardId: boundedDatabaseIdentifier(row.shard_id, "shardId"),
    placementEpoch: positiveDatabaseInteger(row.placement_epoch, "placementEpoch"),
    entityVersion: positiveDatabaseInteger(row.entity_version, "entityVersion"),
  });
}

/**
 * Global, rebuildable Channel -> Space routing projection. Mutations are
 * fenced by the authoritative Space placement epoch and Channel version so a
 * delayed publisher from an old shard cannot overwrite a newer route.
 */
/**
 * A Channel's active route: its current route row, or for a Channel that has
 * none yet, its legacy directory row on the Space's active placement.
 * `channelIdSql` names the Channel id; at most one row.
 */
function channelRouteSql(channelIdSql: string): string {
  return `SELECT channel_id, space_id, shard_id, placement_epoch, entity_version
  FROM control.channel_space_routes
  WHERE channel_id = ${channelIdSql} AND state = 'active'
  UNION ALL
  SELECT legacy.channel_id, legacy.space_id, placement.shard_id,
    placement.placement_epoch, 1 AS entity_version
  FROM control.channel_space_directory legacy
  JOIN control.space_placement placement ON placement.space_id = legacy.space_id
  WHERE legacy.channel_id = ${channelIdSql} AND placement.state = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM control.channel_space_routes current
      WHERE current.channel_id = legacy.channel_id
    )
  LIMIT 1`;
}

const CHANNEL_ROUTE_SQL = channelRouteSql("$1");
const MAX_ROUTES_PER_READ = 512;

export class PostgresChannelSpaceDirectory {
  constructor(private readonly directoryDatabase: AuthorityDatabase) {
    if (directoryDatabase.cacheMode !== "disabled") {
      throw new DatabaseContractError("Channel Space directory requires a cache-disabled database");
    }
  }

  async resolve(
    context: Omit<DatabaseRequestContext, "placement">,
    channelIdValue: string,
  ): Promise<ChannelSpaceRoute | null> {
    const read = await this.readRoute<ChannelSpaceRouteRow>(context, channelIdValue,
      "channel_space_directory_resolve_v2", CHANNEL_ROUTE_SQL);
    return read && read.route;
  }

  /**
   * The Channel's route and its Space's current placement in one statement:
   * exactly what `resolve` followed by `PostgresSpacePlacementDirectory.resolve`
   * would return, read from one snapshot instead of two. `placement` is null
   * when the routed Space has no placement row. The caller still takes the
   * placement fence before reading the shard.
   */
  async resolveWithPlacement(
    context: Omit<DatabaseRequestContext, "placement">,
    channelIdValue: string,
  ): Promise<{ route: ChannelSpaceRoute; placement: SpacePlacement | null } | null> {
    const read = await this.readRoute<ChannelSpaceRouteRow & {
      placement_space_id: string | null;
      placement_shard_id: string | null;
      placement_placement_epoch: string | number | null;
      placement_state: string | null;
      placement_target_shard_id: string | null;
      placement_plan_class: string | null;
    }>(context, channelIdValue, "channel_space_directory_resolve_placed_v1",
      `SELECT route.channel_id, route.space_id, route.shard_id, route.placement_epoch,
          route.entity_version, placement.space_id AS placement_space_id,
          placement.shard_id AS placement_shard_id,
          placement.placement_epoch AS placement_placement_epoch,
          placement.state AS placement_state,
          placement.target_shard_id AS placement_target_shard_id,
          placement.plan_class AS placement_plan_class
        FROM (${CHANNEL_ROUTE_SQL}) route
        LEFT JOIN control.space_placement placement ON placement.space_id = route.space_id`);
    if (!read) return null;
    const { route, row } = read;
    if (row.placement_space_id === null) return { route, placement: null };
    const current = placement({
      space_id: row.placement_space_id,
      shard_id: row.placement_shard_id ?? "",
      placement_epoch: row.placement_placement_epoch ?? 0,
      state: row.placement_state ?? "",
      target_shard_id: row.placement_target_shard_id,
      plan_class: row.placement_plan_class ?? "",
    });
    if (current.spaceId !== route.spaceId) {
      throw new DatabaseContractError("Space placement identity differs");
    }
    return { route, placement: current };
  }

  /**
   * The active routes of many Channels in one single read; a Channel without
   * one is simply absent from the answer.
   */
  async resolveMany(
    context: Omit<DatabaseRequestContext, "placement">,
    channelIdValues: readonly string[],
  ): Promise<ReadonlyMap<string, ChannelSpaceRoute>> {
    const channelIds = [...new Set(channelIdValues.map((id) => boundedDatabaseIdentifier(id, "channelId")))];
    if (channelIds.length > MAX_ROUTES_PER_READ) {
      throw new DatabaseContractError("Channel Space directory read is too large");
    }
    if (channelIds.length === 0) return new Map();
    const rows = await this.directoryDatabase.transaction({
      requestId: context.requestId, operation: context.operation, statement: "single_read",
    }, (transaction) => transaction.query<ChannelSpaceRouteRow>({
      name: "channel_space_directory_resolve_many_v1",
      text: `SELECT route.* FROM UNNEST($1::text[]) requested(channel_id)
        CROSS JOIN LATERAL (${channelRouteSql("requested.channel_id")}) route`,
      values: [channelIds], maxRows: channelIds.length,
    }));
    const requested = new Set(channelIds);
    return new Map(rows.map((row) => {
      if (!requested.has(row.channel_id)) {
        throw new DatabaseContractError("Channel Space directory identity differs");
      }
      return [row.channel_id, channelRoute(row.channel_id, row)] as const;
    }));
  }

  /** One single-read route lookup; the row must name the requested Channel. */
  private async readRoute<Row extends ChannelSpaceRouteRow>(
    context: Omit<DatabaseRequestContext, "placement">,
    channelIdValue: string,
    name: string,
    text: string,
  ): Promise<{ route: ChannelSpaceRoute; row: Row } | null> {
    const channelId = boundedDatabaseIdentifier(channelIdValue, "channelId");
    return this.directoryDatabase.transaction({
      requestId: context.requestId, operation: context.operation, statement: "single_read",
    }, async (transaction) => {
      const rows = await transaction.query<Row>({ name, text, values: [channelId], maxRows: 1 });
      const row = rows[0];
      if (!row) return null;
      if (row.channel_id !== channelId) {
        throw new DatabaseContractError("Channel Space directory identity differs");
      }
      return { route: channelRoute(channelId, row), row };
    });
  }

  async publish(
    context: Omit<DatabaseRequestContext, "placement">,
    raw: ChannelSpaceDirectoryMutation,
  ): Promise<void> {
    await this.publishMany(context, [raw]);
  }

  async publishMany(
    context: Omit<DatabaseRequestContext, "placement">,
    rawMutations: readonly ChannelSpaceDirectoryMutation[],
  ): Promise<void> {
    if (rawMutations.length === 0) return;
    if (rawMutations.length > 10_000) {
      throw new DatabaseContractError("Channel Space directory publication is too large");
    }
    const byChannel = new Map<string, ChannelSpaceDirectoryMutation>();
    for (const raw of rawMutations) {
      const mutation = Object.freeze({
        channelId: boundedDatabaseIdentifier(raw.channelId, "channelId"),
        spaceId: boundedSpaceId(raw.spaceId),
        shardId: boundedDatabaseIdentifier(raw.shardId, "shardId"),
        placementEpoch: positiveDatabaseInteger(raw.placementEpoch, "placementEpoch"),
        entityVersion: positiveDatabaseInteger(raw.entityVersion, "entityVersion"),
        state: raw.state,
        updatedAt: databaseTimestamp(raw.updatedAt, "updatedAt"),
      });
      if (mutation.state !== "active" && mutation.state !== "deleted") {
        throw new DatabaseContractError("Channel Space directory state is invalid");
      }
      const previous = byChannel.get(mutation.channelId);
      if (!previous || mutation.entityVersion > previous.entityVersion ||
          (mutation.entityVersion === previous.entityVersion &&
            mutation.spaceId === previous.spaceId &&
            mutation.placementEpoch >= previous.placementEpoch)) {
        byChannel.set(mutation.channelId, mutation);
      }
    }
    const mutations = [...byChannel.values()];
    const spaceIds = [...new Set(mutations.map((mutation) => mutation.spaceId))];
    await this.directoryDatabase.transaction(context, async (transaction) => {
      const placements = await transaction.query<SpacePlacementRow>({
        name: "channel_space_directory_placement_fence_v1",
        text: `SELECT space_id, shard_id, placement_epoch, state, target_shard_id, plan_class
          FROM control.space_placement WHERE space_id = ANY($1::text[]) FOR SHARE`,
        values: [spaceIds],
        maxRows: spaceIds.length,
      });
      const currentBySpace = new Map(placements.map((row) => {
        const value = placement(row);
        return [value.spaceId, value] as const;
      }));
      for (const mutation of mutations) {
        const current = currentBySpace.get(mutation.spaceId);
        if (!current) throw new DatabaseContractError("Space placement is unavailable");
        if (current.shardId !== mutation.shardId ||
            current.placementEpoch !== mutation.placementEpoch) {
          throw new DatabaseContractError("Channel Space directory publication is stale");
        }
      }
      await transaction.query({
        name: "channel_space_directory_publish_v2",
        text: `WITH incoming AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
              channel_id text, space_id text, shard_id text, placement_epoch bigint,
              entity_version bigint, state text, updated_at timestamptz
            )
          )
          INSERT INTO control.channel_space_routes
            (channel_id, space_id, shard_id, placement_epoch, entity_version, state, updated_at)
          SELECT channel_id, space_id, shard_id, placement_epoch, entity_version, state, updated_at
          FROM incoming
          ON CONFLICT (channel_id) DO UPDATE SET
            space_id = EXCLUDED.space_id,
            shard_id = EXCLUDED.shard_id,
            placement_epoch = EXCLUDED.placement_epoch,
            entity_version = EXCLUDED.entity_version,
            state = EXCLUDED.state,
            updated_at = EXCLUDED.updated_at
          WHERE EXCLUDED.entity_version > control.channel_space_routes.entity_version
             OR (EXCLUDED.entity_version = control.channel_space_routes.entity_version
                 AND EXCLUDED.space_id = control.channel_space_routes.space_id
                 AND EXCLUDED.placement_epoch >= control.channel_space_routes.placement_epoch)`,
        values: [JSON.stringify(mutations.map((mutation) => ({
          channel_id: mutation.channelId,
          space_id: mutation.spaceId,
          shard_id: mutation.shardId,
          placement_epoch: mutation.placementEpoch,
          entity_version: mutation.entityVersion,
          state: mutation.state,
          updated_at: mutation.updatedAt,
        })))],
        maxRows: 0,
      });
    });
  }
}

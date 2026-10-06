import type { AuthorityDatabase } from "./contracts.js";
import { DirectoryAuthority, requireDirectoryPlacement, type DirectoryRouteRow, type DirectoryRequestContext } from "./directory-fence.js";

import { DatabaseContractError } from "./errors.js";
import {
  boundedDatabaseIdentifier, databaseTimestamp,
  positiveDatabaseInteger,
} from "./identifiers.js";

export type EntitySpaceRouteKind =
  | "space-invite"
  | "space-join-request"
  | "content-intent"
  | "content-ref"
  | "billing-checkout"
  | "automation"
  | "run"
  | "instance"
  | "control-intent"
  | "management-action";

const ROUTE_KINDS: ReadonlySet<string> = new Set<EntitySpaceRouteKind>([
  "space-invite", "space-join-request", "content-intent", "content-ref",
  "billing-checkout", "automation", "run", "instance", "control-intent",
  "management-action",
]);

export interface EntitySpaceRoute {
  kind: EntitySpaceRouteKind;
  entityId: string;
  spaceId: string;
  shardId: string;
  placementEpoch: number;
  entityVersion: number;
  routeVersion: number;
}

export interface EntitySpaceRouteMutation extends EntitySpaceRoute {
  state: "active" | "deleted";
  updatedAt: string | Date;
}

interface EntityRouteRow extends DirectoryRouteRow {
  entity_kind: EntitySpaceRouteKind;
  entity_id: string;
  entity_version: string | number;
  route_version: string | number;
}

function kind(value: unknown): EntitySpaceRouteKind {
  const result = boundedDatabaseIdentifier(value, "entityKind");
  if (!ROUTE_KINDS.has(result)) throw new DatabaseContractError("entity route kind is unsupported");
  return result as EntitySpaceRouteKind;
}

function routeMutation(raw: EntitySpaceRouteMutation) {
  const mutation = Object.freeze({
    kind: kind(raw.kind),
    entityId: boundedDatabaseIdentifier(raw.entityId, "entityId"),
    spaceId: boundedDatabaseIdentifier(raw.spaceId, "spaceId"),
    shardId: boundedDatabaseIdentifier(raw.shardId, "shardId"),
    placementEpoch: positiveDatabaseInteger(raw.placementEpoch, "placementEpoch"),
    entityVersion: positiveDatabaseInteger(raw.entityVersion, "entityVersion"),
    routeVersion: positiveDatabaseInteger(raw.routeVersion, "routeVersion"),
    state: raw.state,
    updatedAt: databaseTimestamp(raw.updatedAt, "updatedAt"),
  });
  if (mutation.state !== "active" && mutation.state !== "deleted") {
    throw new DatabaseContractError("entity route state is invalid");
  }
  return mutation;
}

/** Global route for commands that start with an opaque Space-owned entity id. */
export class PostgresEntitySpaceDirectory extends DirectoryAuthority {
  constructor(directoryDatabase: AuthorityDatabase) {
    super(directoryDatabase, "entity");
  }

  async resolve(
    context: DirectoryRequestContext,
    kindValue: EntitySpaceRouteKind,
    entityIdValue: string,
  ): Promise<EntitySpaceRoute | null> {
    const entityKind = kind(kindValue);
    const entityId = boundedDatabaseIdentifier(entityIdValue, "entityId");
    return this.directoryDatabase.transaction(context, async (transaction) => {
      const rows = await transaction.query<EntityRouteRow>({
        name: "entity_space_route_resolve_v1",
        text: `SELECT route.entity_kind, route.entity_id, route.space_id, route.shard_id,
            route.placement_epoch, route.entity_version, route.route_version
          FROM control.entity_space_routes route
          JOIN control.space_placement placement ON placement.space_id = route.space_id
            AND placement.shard_id = route.shard_id
            AND placement.placement_epoch = route.placement_epoch
          WHERE route.entity_kind = $1 AND route.entity_id = $2
            AND route.state = 'active' AND placement.state = 'active'
            AND placement.target_shard_id IS NULL LIMIT 1`,
        values: [entityKind, entityId],
        maxRows: 1,
      });
      const row = rows[0];
      if (!row) return null;
      return Object.freeze({
        kind: kind(row.entity_kind),
        entityId: boundedDatabaseIdentifier(row.entity_id, "entityId"),
        spaceId: boundedDatabaseIdentifier(row.space_id, "spaceId"),
        shardId: boundedDatabaseIdentifier(row.shard_id, "shardId"),
        placementEpoch: positiveDatabaseInteger(row.placement_epoch, "placementEpoch"),
        entityVersion: positiveDatabaseInteger(row.entity_version, "entityVersion"),
        routeVersion: positiveDatabaseInteger(row.route_version, "routeVersion"),
      });
    });
  }

  async publish(
    context: DirectoryRequestContext,
    raw: EntitySpaceRouteMutation,
  ): Promise<void> {
    const mutation = routeMutation(raw);
    await this.directoryDatabase.transaction(context, async (transaction) => {
      const placements = await transaction.query<{
        shard_id: string; placement_epoch: string | number;
      }>({
        name: "entity_space_route_placement_fence_v1",
        text: `SELECT shard_id, placement_epoch FROM control.space_placement
          WHERE space_id = $1 FOR SHARE`,
        values: [mutation.spaceId],
        maxRows: 1,
      });
      requireDirectoryPlacement(placements[0], mutation, "entity route publication is stale");
      await transaction.query({
        name: "entity_space_route_publish_v1",
        text: `INSERT INTO control.entity_space_routes
            (entity_kind,entity_id,space_id,shard_id,placement_epoch,entity_version,
             route_version,state,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (entity_kind,entity_id) DO UPDATE SET
            space_id=EXCLUDED.space_id, shard_id=EXCLUDED.shard_id,
            placement_epoch=EXCLUDED.placement_epoch, entity_version=EXCLUDED.entity_version,
            route_version=EXCLUDED.route_version, state=EXCLUDED.state,
            updated_at=EXCLUDED.updated_at
          WHERE EXCLUDED.route_version > control.entity_space_routes.route_version
             OR (EXCLUDED.route_version = control.entity_space_routes.route_version
                 AND EXCLUDED.placement_epoch > control.entity_space_routes.placement_epoch)
             OR (EXCLUDED.route_version = control.entity_space_routes.route_version
                 AND EXCLUDED.placement_epoch = control.entity_space_routes.placement_epoch
                 AND EXCLUDED.entity_version >= control.entity_space_routes.entity_version)`,
        values: [mutation.kind, mutation.entityId, mutation.spaceId, mutation.shardId,
          mutation.placementEpoch, mutation.entityVersion, mutation.routeVersion,
          mutation.state, mutation.updatedAt],
        maxRows: 0,
      });
    });
  }

  /** Publish a bounded set of routes with one directory checkout and one
   * placement fence. Replaying an identical or older item is harmless. */
  async publishMany(
    context: DirectoryRequestContext,
    rawMutations: readonly EntitySpaceRouteMutation[],
  ): Promise<void> {
    if (!Array.isArray(rawMutations) || rawMutations.length < 1 || rawMutations.length > 200) {
      throw new DatabaseContractError("entity route publication batch is invalid");
    }
    const mutations = rawMutations.map(routeMutation);
    if (new Set(mutations.map((mutation) => `${mutation.kind}\0${mutation.entityId}`)).size !==
        mutations.length) throw new DatabaseContractError("entity route publication batch is duplicated");
    await this.directoryDatabase.transaction(context, async (transaction) => {
      const spaceIds = [...new Set(mutations.map((mutation) => mutation.spaceId))];
      const placements = await transaction.query<{
        space_id: string; shard_id: string; placement_epoch: string | number;
      }>({
        name: "entity_space_route_batch_placement_fence_v1",
        text: `SELECT space_id,shard_id,placement_epoch FROM control.space_placement
          WHERE space_id=ANY($1::text[]) FOR SHARE`,
        values: [spaceIds],
        maxRows: spaceIds.length,
      });
      const bySpace = new Map(placements.map((row) => [String(row.space_id), row]));
      for (const mutation of mutations) {
        const placement = bySpace.get(mutation.spaceId);
        if (!placement || boundedDatabaseIdentifier(placement.shard_id, "shardId") !== mutation.shardId ||
            positiveDatabaseInteger(placement.placement_epoch, "placementEpoch") !==
              mutation.placementEpoch) throw new DatabaseContractError(
          "entity route publication is stale");
      }
      await transaction.query({
        name: "entity_space_route_publish_many_v1",
        text: `INSERT INTO control.entity_space_routes
            (entity_kind,entity_id,space_id,shard_id,placement_epoch,entity_version,
             route_version,state,updated_at)
          SELECT x.entity_kind,x.entity_id,x.space_id,x.shard_id,x.placement_epoch,
            x.entity_version,x.route_version,x.state,x.updated_at
          FROM jsonb_to_recordset($1::jsonb) AS x(entity_kind text,entity_id text,
            space_id text,shard_id text,placement_epoch bigint,entity_version bigint,
            route_version bigint,state text,updated_at timestamptz)
          ON CONFLICT (entity_kind,entity_id) DO UPDATE SET
            space_id=EXCLUDED.space_id, shard_id=EXCLUDED.shard_id,
            placement_epoch=EXCLUDED.placement_epoch, entity_version=EXCLUDED.entity_version,
            route_version=EXCLUDED.route_version, state=EXCLUDED.state,
            updated_at=EXCLUDED.updated_at
          WHERE EXCLUDED.route_version > control.entity_space_routes.route_version
             OR (EXCLUDED.route_version = control.entity_space_routes.route_version
                 AND EXCLUDED.placement_epoch > control.entity_space_routes.placement_epoch)
             OR (EXCLUDED.route_version = control.entity_space_routes.route_version
                 AND EXCLUDED.placement_epoch = control.entity_space_routes.placement_epoch
                 AND EXCLUDED.entity_version >= control.entity_space_routes.entity_version)`,
        values: [JSON.stringify(mutations.map((mutation) => ({
          entity_kind: mutation.kind, entity_id: mutation.entityId, space_id: mutation.spaceId,
          shard_id: mutation.shardId, placement_epoch: mutation.placementEpoch,
          entity_version: mutation.entityVersion, route_version: mutation.routeVersion,
          state: mutation.state, updated_at: mutation.updatedAt,
        })))],
        maxRows: 0,
      });
    });
  }
}

export interface UserSpaceMembershipRoute {
  userId: string;
  spaceId: string;
  role: "owner" | "admin" | "member" | "viewer" | "participant";
  shardId: string;
  placementEpoch: number;
  membershipVersion: number;
  routeVersion: number;
}

export interface UserSpaceMembershipRouteMutation extends UserSpaceMembershipRoute {
  state: "active" | "deleted";
  updatedAt: string | Date;
}

interface MembershipRouteRow extends DirectoryRouteRow {
  user_id: string;
  role: UserSpaceMembershipRoute["role"];
  membership_version: string | number;
  route_version: string | number;
}

interface PlacementRow {
  space_id: string;
  shard_id: string;
  placement_epoch: string | number;
}

function route(row: MembershipRouteRow): UserSpaceMembershipRoute {
  if (!["owner", "admin", "member", "viewer", "participant"].includes(row.role)) {
    throw new DatabaseContractError("membership route role is invalid");
  }
  return Object.freeze({
    userId: boundedDatabaseIdentifier(row.user_id, "userId"),
    spaceId: boundedDatabaseIdentifier(row.space_id, "spaceId"),
    role: row.role,
    shardId: boundedDatabaseIdentifier(row.shard_id, "shardId"),
    placementEpoch: positiveDatabaseInteger(row.placement_epoch, "placementEpoch"),
    membershipVersion: positiveDatabaseInteger(row.membership_version, "membershipVersion"),
    routeVersion: positiveDatabaseInteger(row.route_version, "routeVersion"),
  });
}

/** Global, rebuildable membership directory used to fan Space lists into physical shards. */
export class PostgresUserSpaceMembershipDirectory extends DirectoryAuthority {
  constructor(directoryDatabase: AuthorityDatabase) {
    super(directoryDatabase, "membership");
  }

  async list(
    context: DirectoryRequestContext,
    userIdValue: string,
    cursorValue: string,
    limit: number,
  ): Promise<readonly UserSpaceMembershipRoute[]> {
    const userId = boundedDatabaseIdentifier(userIdValue, "userId");
    const cursor = cursorValue ? boundedDatabaseIdentifier(cursorValue, "cursor") : "";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 201) {
      throw new DatabaseContractError("membership directory limit is invalid");
    }
    return this.directoryDatabase.transaction(context, async (transaction) => {
      const rows = await transaction.query<MembershipRouteRow>({
        name: "user_space_membership_routes_list_v1",
        text: `WITH routes AS (
            SELECT user_id, space_id, role, shard_id, placement_epoch,
              membership_version, route_version
            FROM control.user_space_membership_routes
            WHERE user_id = $1 AND state = 'active'
            UNION ALL
            SELECT legacy.user_id, legacy.space_id, legacy.role, placement.shard_id,
              placement.placement_epoch, legacy.membership_version,
              legacy.membership_version AS route_version
            FROM control.user_space_memberships legacy
            JOIN control.space_placement placement ON placement.space_id = legacy.space_id
            WHERE legacy.user_id = $1 AND placement.state = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM control.user_space_membership_routes current
                WHERE current.user_id = legacy.user_id AND current.space_id = legacy.space_id
              )
          )
          SELECT user_id, space_id, role, shard_id, placement_epoch,
            membership_version, route_version
          FROM routes WHERE space_id > $2 ORDER BY space_id LIMIT $3`,
        values: [userId, cursor, limit],
        maxRows: limit,
      });
      return Object.freeze(rows.map(route));
    });
  }

  async publish(
    context: DirectoryRequestContext,
    raw: UserSpaceMembershipRouteMutation,
  ): Promise<void> {
    const mutation = Object.freeze({
      userId: boundedDatabaseIdentifier(raw.userId, "userId"),
      spaceId: boundedDatabaseIdentifier(raw.spaceId, "spaceId"),
      role: raw.role,
      shardId: boundedDatabaseIdentifier(raw.shardId, "shardId"),
      placementEpoch: positiveDatabaseInteger(raw.placementEpoch, "placementEpoch"),
      membershipVersion: positiveDatabaseInteger(raw.membershipVersion, "membershipVersion"),
      routeVersion: positiveDatabaseInteger(raw.routeVersion, "routeVersion"),
      state: raw.state,
      updatedAt: databaseTimestamp(raw.updatedAt, "updatedAt"),
    });
    if (!["owner", "admin", "member", "viewer", "participant"].includes(mutation.role) ||
        (mutation.state !== "active" && mutation.state !== "deleted")) {
      throw new DatabaseContractError("membership route mutation is invalid");
    }
    await this.directoryDatabase.transaction(context, async (transaction) => {
      const rows = await transaction.query<PlacementRow>({
        name: "user_space_membership_route_placement_fence_v1",
        text: `SELECT space_id, shard_id, placement_epoch FROM control.space_placement
          WHERE space_id = $1 FOR SHARE`,
        values: [mutation.spaceId],
        maxRows: 1,
      });
      requireDirectoryPlacement(rows[0], mutation, "membership route publication is stale");
      await transaction.query({
        name: "user_space_membership_route_publish_v1",
        text: `INSERT INTO control.user_space_membership_routes
            (user_id, space_id, role, shard_id, placement_epoch, membership_version,
             route_version, state, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (user_id,space_id) DO UPDATE SET
            role = EXCLUDED.role, shard_id = EXCLUDED.shard_id,
            placement_epoch = EXCLUDED.placement_epoch,
            membership_version = EXCLUDED.membership_version,
            route_version = EXCLUDED.route_version, state = EXCLUDED.state,
            updated_at = EXCLUDED.updated_at
          WHERE EXCLUDED.route_version > control.user_space_membership_routes.route_version
             OR (EXCLUDED.route_version = control.user_space_membership_routes.route_version
                 AND EXCLUDED.placement_epoch >=
                   control.user_space_membership_routes.placement_epoch)`,
        values: [mutation.userId, mutation.spaceId, mutation.role, mutation.shardId,
          mutation.placementEpoch, mutation.membershipVersion, mutation.routeVersion,
          mutation.state, mutation.updatedAt],
        maxRows: 0,
      });
    });
  }
}

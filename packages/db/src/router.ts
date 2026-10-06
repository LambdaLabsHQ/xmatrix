import { utf8ByteLength } from "@xmatrix/protocol";
import { databaseRequestContext, type DatabaseRequestContext } from "./context.js";
import type {
  AuthorityDatabase,
  AuthorityDatabaseSession,
  DatabaseHealth,
  DatabaseTransaction,
} from "./contracts.js";
import { DatabaseContractError, DatabasePlacementStaleError } from "./errors.js";
import { PostgresSpacePlacementDirectory, type SpacePlacementHints } from "./placement.js";

export interface AuthorityDatabaseRouterOptions {
  /** Correctness connection for the global placement directory and unplaced control facts. */
  directory: AuthorityDatabase;
  /** Finite reviewed shard fleet keyed by exact control.space_placement shard_id. */
  shards: Readonly<Record<string, AuthorityDatabase>>;
}

function shardLabel(value: string): string {
  const result = value.trim();
  if (!result || utf8ByteLength(result) > 300) {
    throw new DatabaseContractError("router shardId is invalid");
  }
  return result;
}

class RoutedAuthorityDatabase implements AuthorityDatabase {
  readonly cacheMode = "disabled" as const;
  readonly placementHints: SpacePlacementHints | undefined;
  private readonly shards: ReadonlyMap<string, AuthorityDatabase>;

  constructor(private readonly directory: AuthorityDatabase, input: AuthorityDatabaseRouterOptions["shards"]) {
    this.placementHints = directory.placementHints;
    if (directory.cacheMode !== "disabled") throw new DatabaseContractError(
      "database router directory must be cache-disabled",
    );
    const shards = new Map<string, AuthorityDatabase>();
    for (const [rawShardId, database] of Object.entries(input)) {
      const shardId = shardLabel(rawShardId);
      if (shards.has(shardId)) throw new DatabaseContractError("database router shardId is duplicated");
      if (database.cacheMode !== "disabled") throw new DatabaseContractError(
        "database router shard must be cache-disabled",
      );
      shards.set(shardId, database);
    }
    if (shards.size === 0) throw new DatabaseContractError(
      "database router requires at least one shard",
    );
    this.shards = shards;
  }

  private select(context: DatabaseRequestContext): AuthorityDatabase {
    if (!context.placement) return this.directory;
    const database = this.shards.get(context.placement.shardId);
    if (!database) throw new DatabaseContractError(
      "placement shard has no configured correctness connection",
    );
    return database;
  }

  openSession(): AuthorityDatabaseSession {
    const directory = this.directory.openSession();
    const sessions = Object.fromEntries([...this.shards.entries()].map(([shardId, database]) => [
      shardId,
      database === this.directory ? directory : database.openSession(),
    ])) as Record<string, AuthorityDatabaseSession>;
    const routed = new RoutedAuthorityDatabase(directory, sessions);
    let closed = false;
    return {
      cacheMode: "disabled",
      ...(routed.placementHints ? { placementHints: routed.placementHints } : {}),
      openSession: () => routed.openSession(),
      transaction: (context, callback) => routed.transaction(context, callback),
      health: (context) => routed.health(context),
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.all([...new Set([directory, ...Object.values(sessions)])]
          .map((session) => session.close()));
      },
    };
  }

  /**
   * A placed transaction whose shard fence refuses its placement has not run
   * any of its work: the fence is checked before the callback's first
   * statement, or in the same statement as a single read. Such a request is
   * routed once more by the directory's current placement, so a Space that
   * moved, or a hint that went stale, costs one refused attempt instead of a
   * failed request. The retried transaction meets the fence again.
   */
  async transaction<T>(rawContext: DatabaseRequestContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
    const context = databaseRequestContext(rawContext);
    try {
      return await this.select(context).transaction(context, callback);
    } catch (error) {
      const routed = context.placement;
      if (!routed || !(error instanceof DatabasePlacementStaleError)) throw error;
      const current = await new PostgresSpacePlacementDirectory(this.directory).read(context, routed.spaceId);
      if (!current || current.state !== "active" || current.targetShardId !== null) {
        throw new DatabaseContractError("Space placement is unavailable");
      }
      if (current.shardId === routed.shardId && current.placementEpoch === routed.placementEpoch) throw error;
      const rerouted = { ...context, placement: {
        spaceId: routed.spaceId, shardId: current.shardId, placementEpoch: current.placementEpoch,
      } };
      return this.select(rerouted).transaction(rerouted, callback);
    }
  }

  async health(rawContext: DatabaseRequestContext): Promise<DatabaseHealth> {
    const context = databaseRequestContext(rawContext);
    return this.select(context).health(context);
  }
}

/**
 * Routes correctness transactions only after a repository resolved a current
 * placement. The selected physical database still rechecks the same shard id,
 * so a mis-keyed fleet entry cannot silently write another shard.
 */
export function createAuthorityDatabaseRouter(
  options: AuthorityDatabaseRouterOptions,
): AuthorityDatabase {
  return new RoutedAuthorityDatabase(options.directory, options.shards);
}

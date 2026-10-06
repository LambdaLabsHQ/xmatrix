import { utf8ByteLength } from "@xmatrix/protocol";
import {
  createAuthorityDatabase,
  createAuthorityDatabaseRouter,
  SpacePlacementHints,
  type AuthorityDatabase,
  type AuthorityDatabaseOptions,
} from "@xmatrix/db";

import type { AppConnectorEnv } from "./app-connectors";
import { postgresDatabaseObservers } from "./postgres-observability";

type HyperdriveBinding = { connectionString: string };

/**
 * Worker bindings form a finite reviewed fleet. Cloudflare bindings cannot be
 * selected dynamically by name, so every possible physical shard is explicit.
 */
export interface PostgresAuthorityFleetEnv {
  /** Directory connection and the default physical shard during rollout. */
  RELAY_POSTGRES?: HyperdriveBinding;
  RELAY_POSTGRES_SHARD_ID?: string;
  RELAY_POSTGRES_SHARD_1?: HyperdriveBinding;
  RELAY_POSTGRES_SHARD_1_ID?: string;
  RELAY_POSTGRES_SHARD_2?: HyperdriveBinding;
  RELAY_POSTGRES_SHARD_2_ID?: string;
  RELAY_POSTGRES_SHARD_3?: HyperdriveBinding;
  RELAY_POSTGRES_SHARD_3_ID?: string;
  RELAY_POSTGRES_SHARD_4?: HyperdriveBinding;
  RELAY_POSTGRES_SHARD_4_ID?: string;
}

/** What the Hub's PostgreSQL product code reads from the Worker env. */
export interface HubAuthorityEnv extends PostgresAuthorityFleetEnv, AppConnectorEnv {
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace;
  XMATRIX_SECRET_CATALOG_KEY?: string;
}

type PhysicalSlot = readonly [
  binding: keyof Pick<PostgresAuthorityFleetEnv,
    "RELAY_POSTGRES_SHARD_1" | "RELAY_POSTGRES_SHARD_2" |
    "RELAY_POSTGRES_SHARD_3" | "RELAY_POSTGRES_SHARD_4">,
  identity: keyof Pick<PostgresAuthorityFleetEnv,
    "RELAY_POSTGRES_SHARD_1_ID" | "RELAY_POSTGRES_SHARD_2_ID" |
    "RELAY_POSTGRES_SHARD_3_ID" | "RELAY_POSTGRES_SHARD_4_ID">,
];

const PHYSICAL_SLOTS: readonly PhysicalSlot[] = [
  ["RELAY_POSTGRES_SHARD_1", "RELAY_POSTGRES_SHARD_1_ID"],
  ["RELAY_POSTGRES_SHARD_2", "RELAY_POSTGRES_SHARD_2_ID"],
  ["RELAY_POSTGRES_SHARD_3", "RELAY_POSTGRES_SHARD_3_ID"],
  ["RELAY_POSTGRES_SHARD_4", "RELAY_POSTGRES_SHARD_4_ID"],
];

export interface PostgresAuthorityPhysicalShard {
  shardId: string;
  database: AuthorityDatabase;
}

export interface PostgresAuthorityFleet {
  /** Placement-aware database used by request-scoped repositories. */
  database: AuthorityDatabase;
  /** Directory-only database for placement and other explicitly global facts. */
  directoryDatabase: AuthorityDatabase;
  /** Default destination for new Spaces until a placement policy selects otherwise. */
  defaultShardId: string;
  /** Explicit physical databases for shard-local schedulers and health checks. */
  physicalShards: readonly PostgresAuthorityPhysicalShard[];
}

type FleetDatabaseOptions = Omit<AuthorityDatabaseOptions, "connectionString" | "shardId">;

export interface PostgresAuthorityFleetDependencies {
  createDatabase?: (options: AuthorityDatabaseOptions) => AuthorityDatabase;
}

function identity(value: string | undefined, field: string): string {
  const result = value?.trim() ?? "";
  if (!result || utf8ByteLength(result) > 160) {
    throw new Error(`${field} is unavailable`);
  }
  return result;
}

function connection(binding: HyperdriveBinding | undefined, field: string): string {
  const result = binding?.connectionString?.trim() ?? "";
  if (!result) throw new Error(`${field} is unavailable`);
  return result;
}

/**
 * Space placement hints for each directory this isolate reaches, shared by
 * every request's fleet so a request does not re-read a placement the last
 * one already resolved. They are routing hints only: each shard's fence
 * still admits or refuses the placement (see `SpacePlacementHints`).
 */
const placementHintsByDirectory = new Map<string, SpacePlacementHints>();

function directoryPlacementHints(directoryConnectionString: string): SpacePlacementHints {
  let hints = placementHintsByDirectory.get(directoryConnectionString);
  if (!hints) {
    hints = new SpacePlacementHints();
    placementHintsByDirectory.set(directoryConnectionString, hints);
  }
  return hints;
}

export function createPostgresAuthorityFleet(
  env: PostgresAuthorityFleetEnv,
  options: FleetDatabaseOptions,
  dependencies: PostgresAuthorityFleetDependencies = {},
): PostgresAuthorityFleet {
  const createDatabase = dependencies.createDatabase ?? createAuthorityDatabase;
  const directoryConnectionString = connection(env.RELAY_POSTGRES, "RELAY_POSTGRES");
  options = {
    ...postgresDatabaseObservers(env),
    // An injected database factory is a test seam; its databases stay unhinted.
    ...(dependencies.createDatabase ? {} : { placementHints: directoryPlacementHints(directoryConnectionString) }),
    ...options,
  };
  const defaultShardId = identity(env.RELAY_POSTGRES_SHARD_ID, "RELAY_POSTGRES_SHARD_ID");
  const directoryDatabase = createDatabase({
    ...options,
    connectionString: directoryConnectionString,
    shardId: defaultShardId,
  });
  const physicalShards: PostgresAuthorityPhysicalShard[] = [
    { shardId: defaultShardId, database: directoryDatabase },
  ];
  const used = new Set([defaultShardId]);

  for (const [bindingField, identityField] of PHYSICAL_SLOTS) {
    const binding = env[bindingField];
    const rawShardId = env[identityField];
    if (!binding && !rawShardId) continue;
    if (!binding || !rawShardId) throw new Error(
      `${String(bindingField)} and ${String(identityField)} must be configured together`,
    );
    const shardId = identity(rawShardId, String(identityField));
    if (used.has(shardId)) throw new Error(`PostgreSQL shard identity ${shardId} is duplicated`);
    used.add(shardId);
    physicalShards.push({
      shardId,
      database: createDatabase({
        ...options,
        connectionString: connection(binding, String(bindingField)),
        shardId,
      }),
    });
  }

  const shards = Object.fromEntries(
    physicalShards.map((item) => [item.shardId, item.database]),
  );
  return Object.freeze({
    database: createAuthorityDatabaseRouter({ directory: directoryDatabase, shards }),
    directoryDatabase,
    defaultShardId,
    physicalShards: Object.freeze(physicalShards),
  });
}

export function createPostgresAuthorityDatabase(
  env: PostgresAuthorityFleetEnv,
  options: FleetDatabaseOptions,
  dependencies: PostgresAuthorityFleetDependencies = {},
): AuthorityDatabase {
  return createPostgresAuthorityFleet(env, options, dependencies).database;
}

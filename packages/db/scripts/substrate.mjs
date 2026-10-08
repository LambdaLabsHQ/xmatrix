#!/usr/bin/env node

import process from "node:process";

import { Client } from "pg";

import { requiredEnv, runIfInvoked, withClient } from "./cli.mjs";

import {
  assertPostgresRuntimeRole,
  loadMigrationManifest,
  reconcileMigrationState,
} from "./migrate.mjs";
import { checkedInMigrationRelations } from "./migration-relations.mjs";

export const OPERATIONAL_FACT_TABLES = Object.freeze([
  "space_placement",
  "agent_launches",
  "agent_reborn_intents",
  "idempotency_keys",
  "outbox",
  "space_storage_usage",
  "user_space_channel_view_preferences",
  "user_space_locale_preferences",
]);

export const AUTH_OBSERVATION_TABLES = Object.freeze([
  "auth_accounts",
  "auth_jwks",
  "auth_sessions",
  "auth_shadow_backfill_progress",
  "auth_shadow_runs",
  "auth_users",
  "auth_verifications",
  "authority_migration_receipts",
  "retired_human_handles",
]);

export const CAPACITY_POLICY = Object.freeze({
  hostFilesystem: Object.freeze({
    warningPercent: 70,
    criticalPercent: 80,
    emergencyPercent: 90,
    minimumFreeBytes: 10 * 1024 ** 3,
  }),
  postgresLogical: Object.freeze({
    warningBytes: 8 * 1024 ** 3,
    criticalBytes: 12 * 1024 ** 3,
    emergencyBytes: 16 * 1024 ** 3,
  }),
});


function boundedLabel(value, name, maximum) {
  if (!value || value.length > maximum || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function operationalOptions(source = process.env) {
  const shardId = boundedLabel(requiredEnv("POSTGRES_SHARD_ID", source), "POSTGRES_SHARD_ID", 300);
  const fleetShardIds = (source.POSTGRES_FLEET_SHARD_IDS ?? shardId)
    .split(",")
    .map((value) => boundedLabel(value.trim(), "POSTGRES_FLEET_SHARD_IDS", 300));
  if (new Set(fleetShardIds).size !== fleetShardIds.length || !fleetShardIds.includes(shardId)) {
    throw new Error("POSTGRES_FLEET_SHARD_IDS must be unique and include POSTGRES_SHARD_ID");
  }
  return Object.freeze({
    shardId,
    fleetShardIds: Object.freeze(fleetShardIds.sort()),
    capacityClass: boundedLabel(
      requiredEnv("POSTGRES_CAPACITY_CLASS", source),
      "POSTGRES_CAPACITY_CLASS",
      100,
    ),
  });
}

function exactInteger(value, name) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} is outside the supported integer range`);
  }
  return parsed;
}

export function capacityLevel(databaseBytes, policy = CAPACITY_POLICY.postgresLogical) {
  const bytes = exactInteger(databaseBytes, "databaseBytes");
  if (bytes >= policy.emergencyBytes) return "emergency";
  if (bytes >= policy.criticalBytes) return "critical";
  if (bytes >= policy.warningBytes) return "warning";
  return "healthy";
}

const sorted = (names) => JSON.stringify([...names].sort());

/**
 * `expected` is what the checked-in migrations leave ({@link checkedInMigrationRelations}):
 * the schema has one written source, so a migration never also edits an inventory here.
 */
export function assertOperationalSnapshot(snapshot, options, expected) {
  if (sorted(snapshot.tables) !== sorted(expected.tables)) {
    throw new Error("PostgreSQL substrate table inventory differs");
  }
  if (sorted(snapshot.views) !== sorted(expected.views)) {
    throw new Error("PostgreSQL substrate view inventory differs");
  }
  if (snapshot.pendingMigrations.length !== 0) {
    throw new Error("PostgreSQL substrate has pending migrations");
  }
  if (JSON.stringify(snapshot.shards.map(({ shard_id }) => shard_id)) !==
      JSON.stringify(options.fleetShardIds) ||
      snapshot.shards.some(({ state, capacity_class }) =>
        !new Set(["active", "draining", "offline"]).has(state) ||
        capacity_class !== options.capacityClass)) {
    throw new Error("PostgreSQL physical shard metadata differs");
  }
  if (snapshot.localShardId !== options.shardId) {
    throw new Error("PostgreSQL local shard identity differs");
  }
  const factNames = Object.keys(snapshot.factCounts).sort();
  if (JSON.stringify(factNames) !== JSON.stringify([...OPERATIONAL_FACT_TABLES].sort())) {
    throw new Error("PostgreSQL expand target fact inventory differs");
  }
  for (const [name, value] of Object.entries(snapshot.factCounts)) {
    exactInteger(value, name);
  }
  const authNames = Object.keys(snapshot.authCounts).sort();
  if (JSON.stringify(authNames) !== JSON.stringify([...AUTH_OBSERVATION_TABLES].sort())) {
    throw new Error("PostgreSQL Auth observation inventory differs");
  }
  for (const [name, value] of Object.entries(snapshot.authCounts)) exactInteger(value, name);
}

export function assertRuntimeAccessSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.roleExists !== true) {
    throw new Error("PostgreSQL runtime role is unavailable");
  }
  if (typeof snapshot.runtimeRole !== "string" || snapshot.runtimeRole.length === 0) {
    throw new Error("PostgreSQL runtime role identity is invalid");
  }
  const checkedRelations = exactInteger(snapshot.checkedRelations, "checkedRelations");
  if (checkedRelations === 0) throw new Error("PostgreSQL substrate has no relations");
  if (!Array.isArray(snapshot.deniedRelations) || snapshot.deniedRelations.length !== 0) {
    throw new Error("PostgreSQL runtime role lacks access to substrate relations");
  }
  const checkedSequences = exactInteger(snapshot.checkedSequences, "checkedSequences");
  if (!Array.isArray(snapshot.deniedSequences) || snapshot.deniedSequences.length !== 0) {
    throw new Error("PostgreSQL runtime role lacks access to substrate sequences");
  }
  if (!Array.isArray(snapshot.deniedSchemas) || snapshot.deniedSchemas.length !== 0) {
    throw new Error("PostgreSQL runtime role lacks schema access");
  }
  return { checkedRelations, checkedSequences };
}

function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["seed", "verify", "capacity", "runtime-access"]).has(command) ||
      rest.length !== 0) {
    throw new Error("Usage: substrate.mjs <seed|verify|capacity|runtime-access>");
  }
  return command;
}

async function connect() {
  const client = new Client({
    connectionString: requiredEnv("DATABASE_URL"),
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    application_name: "xmatrix-db-substrate-operator",
  });
  await client.connect();
  return client;
}

export async function readOperationalSnapshot(client, options) {
  const manifest = await loadMigrationManifest();
  const ledger = await client.query(`SELECT migration_id, checksum_sha256, phase,
    app_revision, execution_ms, applied_at
    FROM control.schema_migrations ORDER BY migration_id`);
  const pendingMigrations = reconcileMigrationState(manifest, ledger.rows)
    .map(({ id }) => id);
  const tables = await client.query(`SELECT table_schema || '.' || table_name AS name
    FROM information_schema.tables
    WHERE table_schema IN ('control', 'data') AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name`);
  const views = await client.query(`SELECT table_schema || '.' || table_name AS name
    FROM information_schema.views
    WHERE table_schema IN ('control', 'data')
    ORDER BY table_schema, table_name`);
  const shards = await client.query(`SELECT shard_id, state, capacity_class
    FROM control.postgres_shards ORDER BY shard_id`);
  const localIdentity = await client.query(`SELECT shard_id
    FROM control.postgres_local_identity WHERE singleton = true`);
  const counts = await client.query(`SELECT
    (SELECT count(*) FROM control.auth_accounts) AS auth_accounts,
    (SELECT count(*) FROM control.auth_jwks) AS auth_jwks,
    (SELECT count(*) FROM control.auth_sessions) AS auth_sessions,
    (SELECT count(*) FROM control.auth_users) AS auth_users,
    (SELECT count(*) FROM control.auth_verifications) AS auth_verifications,
    (SELECT count(*) FROM control.authority_migration_receipts) AS authority_migration_receipts,
    (SELECT count(*) FROM control.retired_human_handles) AS retired_human_handles`);
  const shadow = await client.query(`SELECT
    (SELECT count(*) FROM control.auth_shadow_backfill_progress) AS auth_shadow_backfill_progress,
    (SELECT count(*) FROM control.auth_shadow_runs) AS auth_shadow_runs`);
  const facts = await client.query(`SELECT
    (SELECT count(*) FROM control.space_placement) AS space_placement,
    (SELECT count(*) FROM data.agent_launches) AS agent_launches,
    (SELECT count(*) FROM data.agent_reborn_intents) AS agent_reborn_intents,
    (SELECT count(*) FROM data.idempotency_keys) AS idempotency_keys,
    (SELECT count(*) FROM data.outbox) AS outbox,
    (SELECT count(*) FROM data.space_storage_usage) AS space_storage_usage,
    (SELECT count(*) FROM data.user_space_channel_view_preferences)
      AS user_space_channel_view_preferences,
    (SELECT count(*) FROM data.user_space_locale_preferences)
      AS user_space_locale_preferences`);
  const snapshot = {
    ledger: ledger.rows.map((row) => ({
      migrationId: row.migration_id,
      checksumSha256: row.checksum_sha256,
      phase: row.phase,
      appRevision: row.app_revision,
    })),
    pendingMigrations,
    tables: tables.rows.map(({ name }) => name),
    views: views.rows.map(({ name }) => name),
    shards: shards.rows,
    localShardId: localIdentity.rows.length === 1 ? localIdentity.rows[0].shard_id : null,
    factCounts: facts.rows[0],
    authCounts: { ...counts.rows[0], ...shadow.rows[0] },
  };
  assertOperationalSnapshot(snapshot, options, await checkedInMigrationRelations());
  return snapshot;
}

async function seed(client, options) {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('xmatrix-postgres-shard-seed', 0))",
    );
    for (const shardId of options.fleetShardIds) {
      await client.query(`INSERT INTO control.postgres_shards
        (shard_id, state, capacity_class, created_at, updated_at)
        VALUES ($1, 'active', $2, clock_timestamp(), clock_timestamp())
        ON CONFLICT (shard_id) DO NOTHING`, [shardId, options.capacityClass]);
    }
    await client.query(`INSERT INTO control.postgres_local_identity
      (singleton, shard_id, created_at)
      VALUES (true, $1, clock_timestamp())
      ON CONFLICT (singleton) DO NOTHING`, [options.shardId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return readOperationalSnapshot(client, options);
}

async function capacity(client, options) {
  const database = await client.query(`SELECT
    pg_database_size(current_database()) AS database_bytes,
    current_setting('max_connections')::bigint AS max_connections,
    (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections,
    COALESCE((SELECT sum(pg_total_relation_size(c.oid))
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('control', 'data') AND c.relkind IN ('r', 'm')), 0)
      AS substrate_bytes`);
  const relations = await client.query(`SELECT
    n.nspname || '.' || c.relname AS relation,
    pg_total_relation_size(c.oid) AS total_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('control', 'data') AND c.relkind IN ('r', 'm')
    ORDER BY relation`);
  const row = database.rows[0];
  const databaseBytes = exactInteger(row.database_bytes, "database_bytes");
  return {
    shardId: options.shardId,
    databaseBytes,
    substrateBytes: exactInteger(row.substrate_bytes, "substrate_bytes"),
    maxConnections: exactInteger(row.max_connections, "max_connections"),
    connections: exactInteger(row.connections, "connections"),
    level: capacityLevel(databaseBytes),
    policy: CAPACITY_POLICY,
    relations: relations.rows.map((relation) => ({
      relation: relation.relation,
      totalBytes: exactInteger(relation.total_bytes, `${relation.relation}.total_bytes`),
    })),
  };
}

export async function readRuntimeAccessSnapshot(
  client,
  roleInput = process.env.POSTGRES_RUNTIME_ROLE,
) {
  const roleName = assertPostgresRuntimeRole(roleInput);
  const role = await client.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS found", [roleName]);
  if (role.rows[0]?.found !== true) {
    const snapshot = { runtimeRole: roleName, roleExists: false,
      checkedRelations: 0, deniedRelations: [], checkedSequences: 0,
      deniedSequences: [], deniedSchemas: [] };
    assertRuntimeAccessSnapshot(snapshot);
  }
  const relations = await client.query(`SELECT namespace.nspname||'.'||class.relname AS relation,
      has_table_privilege($1,class.oid,'SELECT,INSERT,UPDATE,DELETE') AS full_access
    FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname IN ('control','data') AND class.relkind IN ('r','p','v')
    ORDER BY namespace.nspname,class.relname`, [roleName]);
  const sequences = await client.query(`SELECT namespace.nspname||'.'||class.relname AS relation,
      has_sequence_privilege($1,class.oid,'USAGE,SELECT') AS full_access
    FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname IN ('control','data') AND class.relkind='S'
    ORDER BY namespace.nspname,class.relname`, [roleName]);
  const schemas = await client.query(`SELECT nspname,
      has_schema_privilege($1,oid,'USAGE') AS full_access
    FROM pg_namespace WHERE nspname IN ('control','data') ORDER BY nspname`, [roleName]);
  const snapshot = {
    runtimeRole: roleName,
    roleExists: true,
    checkedRelations: relations.rows.length,
    deniedRelations: relations.rows.filter((row) => row.full_access !== true)
      .map((row) => row.relation),
    checkedSequences: sequences.rows.length,
    deniedSequences: sequences.rows.filter((row) => row.full_access !== true)
      .map((row) => row.relation),
    deniedSchemas: schemas.rows.filter((row) => row.full_access !== true)
      .map((row) => row.nspname),
  };
  assertRuntimeAccessSnapshot(snapshot);
  return snapshot;
}

export async function run(argv = process.argv.slice(2)) {
  const command = parseCommand(argv);
  const options = operationalOptions();
  const client = await connect();
  return withClient(client, async () => {
    const result = command === "seed"
      ? await seed(client, options)
      : command === "verify"
        ? await readOperationalSnapshot(client, options)
        : command === "capacity"
          ? await capacity(client, options)
          : await readRuntimeAccessSnapshot(client);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}

runIfInvoked(import.meta.url, run);

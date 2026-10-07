#!/usr/bin/env node
import { executableSql } from "./sql-source.mjs";

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { runIfInvoked, withClientTransaction } from "./cli.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultMigrationsDirectory = resolve(packageRoot, "migrations");
const migrationPattern = /^(\d{4})_(expand|contract)_([a-z0-9_]+)\.sql$/u;
const destructiveExpandPatterns = [
  /\bDROP\s+(?:SCHEMA|TABLE|INDEX|VIEW|TYPE|FUNCTION|TRIGGER)\b/iu,
  /\bTRUNCATE\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bUPDATE\s+[A-Za-z_"]/iu,
  /\bALTER\s+TYPE\b/iu,
  /\bCREATE\s+OR\s+REPLACE\b/iu,
];


export function assertExpandOnlyPostgresMigration(source, name = "migration") {
  let sql = executableSql(source);
  const newTables = new Set([...sql.matchAll(/\bCREATE\s+TABLE\s+([a-z_][a-z0-9_.]*)\s*\(/giu)].map((match) => match[1].toLowerCase()));
  // UPDATE in a trigger event is not a mutation. An expand migration may add
  // this exact content guard only to a table it creates, never an existing writer.
  sql = sql.replace(/\bCREATE\s+TRIGGER\s+[a-z_][a-z0-9_]*\s+BEFORE\s+UPDATE\s+ON\s+([a-z_][a-z0-9_.]*)\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+[a-z_][a-z0-9_.]*\(\)\s*;/giu,
    (statement, table) => newTables.has(table.toLowerCase()) ? "" : statement);
  for (const pattern of destructiveExpandPatterns) {
    if (pattern.test(sql)) throw new Error(`${name} is not expand-only; matched ${pattern}`);
  }
  for (const statement of sql.split(";")) {
    if (!/\bALTER\s+TABLE\b/iu.test(statement)) continue;
    const addsNullableColumn = /\bADD\s+COLUMN\b/iu.test(statement) &&
      !/\bNOT\s+NULL\b/iu.test(statement);
    const addsUnvalidatedConstraint = /\bADD\s+CONSTRAINT\b[\s\S]*\bNOT\s+VALID\b/iu.test(statement);
    const validatesConstraint = /\bVALIDATE\s+CONSTRAINT\b/iu.test(statement);
    // Relaxing NOT NULL only widens what the column accepts: code that still
    // writes values is unaffected, so it is expand-compatible. One column per
    // statement keeps every other ALTER form out of this exemption.
    const dropsNotNull = /^\s*ALTER\s+TABLE\s+[A-Za-z_][A-Za-z0-9_."]*\s+ALTER\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_"]*\s+DROP\s+NOT\s+NULL\s*$/iu
      .test(statement);
    if (!addsNullableColumn && !addsUnvalidatedConstraint && !validatesConstraint && !dropsNotNull) {
      throw new Error(`${name} is not expand-only; unsupported ALTER TABLE`);
    }
  }
}

function checksum(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function assertPostgresRuntimeRole(value) {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error(
      "POSTGRES_RUNTIME_ROLE must be an explicit unquoted PostgreSQL role identifier",
    );
  }
  return value;
}

export async function convergeRuntimeAccess(client, runtimeRoleInput) {
  const runtimeRole = assertPostgresRuntimeRole(runtimeRoleInput);
  const role = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS found",
    [runtimeRole],
  );
  if (role.rows[0]?.found !== true) {
    throw new Error(`PostgreSQL runtime role does not exist: ${runtimeRole}`);
  }

  await client.query("SELECT set_config('xmatrix.runtime_role', $1, true)", [runtimeRole]);
  await client.query(`DO $runtime_access$
    DECLARE
      runtime_role TEXT := current_setting('xmatrix.runtime_role');
      schema_row RECORD;
      relation_row RECORD;
    BEGIN
      FOR schema_row IN
        SELECT oid,nspname,nspowner FROM pg_namespace
        WHERE nspname IN ('control','data')
        ORDER BY nspname
      LOOP
        IF schema_row.nspowner = (SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
          EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',schema_row.nspname,runtime_role);
        END IF;
      END LOOP;

      FOR relation_row IN
        SELECT namespace.nspname AS schema_name,class.relname AS relation_name,class.relkind
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname IN ('control','data')
          AND class.relkind IN ('r','p','v','S')
          AND class.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        ORDER BY namespace.nspname,class.relname
      LOOP
        IF relation_row.relkind = 'S' THEN
          EXECUTE format(
            'GRANT USAGE, SELECT ON SEQUENCE %I.%I TO %I',
            relation_row.schema_name,relation_row.relation_name,runtime_role
          );
        ELSE
          EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
            relation_row.schema_name,relation_row.relation_name,runtime_role
          );
        END IF;
      END LOOP;

      FOR schema_row IN
        SELECT nspname FROM pg_namespace
        WHERE nspname IN ('control','data')
        ORDER BY nspname
      LOOP
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
          current_user,schema_row.nspname,runtime_role
        );
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
            'GRANT USAGE, SELECT ON SEQUENCES TO %I',
          current_user,schema_row.nspname,runtime_role
        );
      END LOOP;
    END
    $runtime_access$`);

  const access = await client.query(`SELECT kind,name,allowed FROM (
      SELECT 'schema'::text AS kind,namespace.nspname AS name,
        has_schema_privilege($1,namespace.oid,'USAGE') AS allowed
      FROM pg_namespace namespace
      WHERE namespace.nspname IN ('control','data')
      UNION ALL
      SELECT CASE class.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
        namespace.nspname||'.'||class.relname AS name,
        CASE WHEN class.relkind='S'
          THEN has_sequence_privilege($1,class.oid,'USAGE,SELECT')
          ELSE has_table_privilege($1,class.oid,'SELECT,INSERT,UPDATE,DELETE')
        END AS allowed
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname IN ('control','data')
        AND class.relkind IN ('r','p','v','S')
    ) access ORDER BY kind,name`, [runtimeRole]);
  const denied = access.rows.filter((row) => row.allowed !== true)
    .map(({ kind, name }) => `${kind}:${name}`);
  if (denied.length > 0) {
    throw new Error(
      `PostgreSQL runtime role lacks required access: ${denied.join(", ")}`,
    );
  }
  return {
    runtimeRole,
    schemas: access.rows.filter(({ kind }) => kind === "schema").length,
    tables: access.rows.filter(({ kind }) => kind === "table").length,
    views: access.rows.filter(({ kind }) => kind === "view").length,
    sequences: access.rows.filter(({ kind }) => kind === "sequence").length,
  };
}

export async function loadMigrationManifest(directory = defaultMigrationsDirectory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (names.length === 0) throw new Error(`No PostgreSQL migrations found in ${directory}`);
  const migrations = [];
  for (const [index, name] of names.entries()) {
    const match = migrationPattern.exec(name);
    if (!match) throw new Error(`Invalid PostgreSQL migration filename: ${name}`);
    const sequence = Number(match[1]);
    if (sequence !== index) {
      throw new Error(`PostgreSQL migration sequence must be contiguous from 0000; found ${name}`);
    }
    const source = await readFile(resolve(directory, name), "utf8");
    if (!source.trim()) throw new Error(`${name} is empty`);
    const phase = match[2];
    if (phase === "expand") assertExpandOnlyPostgresMigration(source, name);
    migrations.push(Object.freeze({
      id: name.slice(0, -4),
      name,
      phase,
      checksumSha256: checksum(source),
      source,
    }));
  }
  return Object.freeze(migrations);
}

export function parseMigrationArgs(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["check", "plan", "apply"]).has(command)) {
    throw new Error("Usage: migrate.mjs <check|plan|apply> [--existing-expand-only] [--allow-contract] [--revision=<sha>]");
  }
  let allowContract = false;
  let existingExpandOnly = false;
  let revision = process.env.XMATRIX_DEPLOY_SHA || "local";
  for (const argument of rest) {
    if (argument === "--existing-expand-only") {
      existingExpandOnly = true;
      continue;
    }
    if (argument === "--allow-contract") {
      allowContract = true;
      continue;
    }
    if (argument.startsWith("--revision=")) {
      revision = argument.slice("--revision=".length).trim();
      continue;
    }
    throw new Error(`Unknown migration argument: ${argument}`);
  }
  if (!revision || revision.length > 200) throw new Error("Migration revision is invalid");
  if (existingExpandOnly && (command === "check" || allowContract ||
      !/^[0-9a-f]{40}$/u.test(revision))) {
    throw new Error("Existing expand migrations require plan/apply, an exact revision, and no contract override");
  }
  return { command, allowContract, revision, existingExpandOnly };
}

export async function assertExistingExpandTarget(client, manifest, rows, shardId) {
  if (typeof shardId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,299}$/u.test(shardId)) {
    throw new Error("Existing expand migrations require POSTGRES_SHARD_ID");
  }
  const pending = reconcileMigrationState(manifest, rows);
  if (rows.length === 0 || pending.some(({ phase }) => phase !== "expand")) {
    throw new Error("Existing expand migrations reject an empty ledger or pending contract migration");
  }
  const identity = await client.query("SELECT shard_id FROM control.postgres_local_identity");
  if (identity.rows.length !== 1 || identity.rows[0].shard_id !== shardId) {
    throw new Error("Existing expand migration local shard identity differs");
  }
  return pending;
}

async function ledgerExists(client) {
  const result = await client.query(
    "SELECT to_regclass('control.schema_migrations')::text AS ledger",
  );
  return result.rows[0]?.ledger === "control.schema_migrations";
}

async function readLedger(client) {
  if (!(await ledgerExists(client))) return [];
  const result = await client.query(`SELECT migration_id, checksum_sha256, phase,
    app_revision, execution_ms, applied_at
    FROM control.schema_migrations ORDER BY migration_id`);
  return result.rows;
}

export function reconcileMigrationState(manifest, rows) {
  const expected = new Map(manifest.map((migration) => [migration.id, migration]));
  const applied = new Map();
  for (const row of rows) {
    const migration = expected.get(row.migration_id);
    if (!migration) throw new Error(`Database has unknown migration ${row.migration_id}`);
    if (migration.checksumSha256 !== row.checksum_sha256) {
      throw new Error(`Applied migration checksum changed: ${row.migration_id}`);
    }
    if (migration.phase !== row.phase) {
      throw new Error(`Applied migration phase changed: ${row.migration_id}`);
    }
    applied.set(row.migration_id, row);
  }
  const pending = manifest.filter((migration) => !applied.has(migration.id));
  const firstPendingIndex = pending.length === 0 ? manifest.length : manifest.indexOf(pending[0]);
  for (const migration of manifest.slice(firstPendingIndex + 1)) {
    if (applied.has(migration.id)) {
      throw new Error(`Migration ledger has a gap before ${migration.id}`);
    }
  }
  return pending;
}

async function connect() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for plan and apply");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    application_name: "xmatrix-db-migrator",
  });
  await client.connect();
  return client;
}

function printablePlan(manifest, pending) {
  return {
    manifest: manifest.map(({ id, phase, checksumSha256 }) => ({ id, phase, checksumSha256 })),
    pending: pending.map(({ id, phase }) => ({ id, phase })),
  };
}

async function applyMigration(
  client,
  migration,
  revision,
  runtimeRole,
) {
  const startedAt = performance.now();
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('xmatrix-postgres-migrations', 0))",
    );
    await client.query("SELECT set_config('xmatrix.runtime_role', $1, true)", [runtimeRole]);
    if (await ledgerExists(client)) {
      const existing = await client.query(
        "SELECT checksum_sha256, phase FROM control.schema_migrations WHERE migration_id = $1",
        [migration.id],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.checksum_sha256 !== migration.checksumSha256 || row.phase !== migration.phase) {
          throw new Error(`Concurrent migration checksum conflict: ${migration.id}`);
        }
        await convergeRuntimeAccess(client, runtimeRole);
        await client.query("COMMIT");
        return false;
      }
    } else if (migration.id !== "0000_expand_migration_ledger") {
      throw new Error("Migration ledger is absent before a non-bootstrap migration");
    }
    await client.query(migration.source);
    await convergeRuntimeAccess(client, runtimeRole);
    const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
    await client.query(
      `INSERT INTO control.schema_migrations
        (migration_id, checksum_sha256, phase, app_revision, execution_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        migration.id,
        migration.checksumSha256,
        migration.phase,
        revision,
        executionMs,
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function convergeRuntimeAccessTransaction(client, runtimeRole) {
  return withClientTransaction(client, async () => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('xmatrix-postgres-migrations', 0))");
    return convergeRuntimeAccess(client, runtimeRole);
  });
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseMigrationArgs(argv);
  const manifest = await loadMigrationManifest();
  if (options.command === "check") {
    process.stdout.write(`${JSON.stringify({
      validated: printablePlan(manifest, []).manifest,
    }, null, 2)}\n`);
    return;
  }
  const runtimeRole = options.command === "apply"
    ? assertPostgresRuntimeRole(process.env.POSTGRES_RUNTIME_ROLE)
    : null;

  const client = await connect();
  try {
    const rows = await readLedger(client);
    const pending = options.existingExpandOnly
      ? await assertExistingExpandTarget(client, manifest, rows, process.env.POSTGRES_SHARD_ID)
      : reconcileMigrationState(manifest, rows);
    if (options.existingExpandOnly) {
      await client.query("SET lock_timeout = '5s'");
      await client.query("SET statement_timeout = '25s'");
    }
    if (pending.some((migration) => migration.phase === "contract") &&
        !options.allowContract) {
      throw new Error("Pending contract migration requires --allow-contract");
    }
    if (options.command === "plan") {
      process.stdout.write(`${JSON.stringify(printablePlan(manifest, pending), null, 2)}\n`);
      return;
    }
    const applied = [];
    for (const migration of pending) {
      if (await applyMigration(
        client,
        migration,
        options.revision,
        runtimeRole,
      )) applied.push(migration.id);
    }
    const runtimeAccess = await convergeRuntimeAccessTransaction(client, runtimeRole);
    process.stdout.write(`${JSON.stringify({ applied, runtimeAccess }, null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

runIfInvoked(import.meta.url, run);

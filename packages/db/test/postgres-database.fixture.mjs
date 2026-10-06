import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { createAuthorityDatabase } from "../dist/index.js";

export const connectionString = process.env.XMATRIX_TEST_POSTGRES_URL;
export const integration = connectionString || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true"
  ? test : test.skip;

/** Independent bounded commands plus a direct connection for connector fixture setup. */
export async function connectorDatabase(applicationName) {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required for connector tests");
  const client = new Client({ connectionString });
  await client.connect();
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0", applicationName,
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 });
  return { client, database, sql: (text, values) => client.query(text, values) };
}

/** A row-bounded transaction, optionally targeting a test schema. */
export function boundedPostgresTransaction(client, rewrite = text => text) {
  return { async query({ maxRows, text, values, name }) {
    const result = await client.query(rewrite(text), values);
    assert.ok(result.rows.length <= maxRows, `query ${name} exceeded its row bound`);
    return result.rows;
  } };
}

/** An AuthorityDatabase backed by a test's existing connection. */
export function postgresDatabase(client, rewrite) {
  return { cacheMode: "disabled", async transaction(_context, callback) {
    await client.query("BEGIN");
    try {
      const value = await callback(boundedPostgresTransaction(client, rewrite));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } };
}

/** Independent command transactions, preserving the test's concurrency. */
export function postgresConnections(statementTimeoutMs, {
  rewrite = text => text, checkContext = () => {}, afterCommit = () => {},
} = {}) {
  return { cacheMode: "disabled", async transaction(context, callback) {
    await checkContext(context);
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const result = await postgresDatabase(client, text => rewrite(text, context)).transaction(context, async tx => {
        if (statementTimeoutMs) await client.query("SELECT set_config('statement_timeout',$1,true)",
          [String(statementTimeoutMs)]);
        return callback(tx);
      });
      await afterCommit(context);
      return result;
    } finally { await client.end(); }
  } };
}

/** An outer rollback keeps ad hoc historical schema fixtures isolated. */
export async function beginTestSchema(client, schema) {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${schema}`);
  return text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
}

export async function registrationChannelTables(client, schema) {
  await client.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,role text)`);
  await client.query(`CREATE TABLE ${schema}.channels
    (channel_id text,space_id text,mode text,metadata_json jsonb,version bigint,archived_at timestamptz)`);
  await client.query(`CREATE TABLE ${schema}.channel_access
    (channel_id text,space_id text,subject_kind text,subject_id text)`);
}

/** Commands in a schema test roll back to a savepoint while its outer fixture remains. */
export function savepointDatabase(client, rewrite, checkContext = () => {}) {
  return { cacheMode: "disabled", async transaction(context, callback) {
    checkContext(context);
    await client.query("SAVEPOINT command");
    try {
      const result = await callback(boundedPostgresTransaction(client, rewrite));
      await client.query("RELEASE SAVEPOINT command");
      return result;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT command");
      throw error;
    }
  } };
}

export async function applyTestMigrations(client, files, rewrite) {
  for (const file of files) await client.query(rewrite(
    await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")));
}

/** A uniquely named database and runtime role, removed even if setup fails. */
export async function isolatedPostgres(prefix, { migrate = true, shard = false, runtimeRole = true } = {}) {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  assert.match(prefix, /^[a-z_][a-z0-9_]*$/u);
  const suffix = randomUUID().replaceAll("-", "");
  const name = `${prefix}_${suffix}`, role = `${prefix}_rt_${suffix}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  let client, session, created = false, roleCreated = false;
  const close = async () => {
    await session?.close?.();
    await client?.end();
    if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    if (roleCreated) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    if (runtimeRole) {
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      roleCreated = true;
    }
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    let applied;
    if (migrate) applied = JSON.parse((await promisify(execFile)(process.execPath,
      [new URL("../scripts/migrate.mjs", import.meta.url).pathname, "apply", "--revision=local", "--allow-contract"], {
        timeout: 120_000, env: { ...process.env, DATABASE_URL: url.toString(), POSTGRES_RUNTIME_ROLE: role },
      })).stdout);
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    const run = async (text, values = []) => (await client.query({ text, values })).rows;
    if (shard) {
      await run(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
        VALUES ('shard-0','active','test',now(),now())`);
      session = createAuthorityDatabase({ connectionString: url.toString(), shardId: "shard-0" }).openSession();
    }
    return { client, session, run, url, role, suffix, applied, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The isolated current schema plus one migration source tested for replay safety. */
export async function migrationFixture(prefix, migration) {
  const isolated = await isolatedPostgres(prefix);
  try {
    assert.ok(isolated.applied.applied.includes(migration));
    const source = await readFile(new URL(`../migrations/${migration}.sql`, import.meta.url), "utf8");
    return { ...isolated, source };
  } catch (error) { await isolated.close(); throw error; }
}

/** A request session on the shared integration database, with optional shard setup. */
export async function connectedAuthority({ shard = false } = {}) {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  const session = createAuthorityDatabase({ connectionString, shardId: "shard-0" }).openSession();
  try {
    if (shard) await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
    return { client, session, async close() { await session.close(); await client.end(); } };
  } catch (error) { await session.close(); await client.end(); throw error; }
}

/** Remove a test Space's rows in the caller's dependency order. */
export async function deleteSpaceRows(client, spaceId, tables, { shard = false } = {}) {
  for (const table of tables) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/u);
    await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [spaceId]);
  }
  await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [spaceId]);
  if (shard) await client.query("DELETE FROM control.postgres_shards WHERE shard_id=$1", [spaceId]);
}

export async function seedTestSpacePlacement(client, spaceId, at) {
  await client.query(`INSERT INTO control.postgres_shards
    (shard_id,state,capacity_class,created_at,updated_at)
    VALUES ('shard-0','active','test',$1,$1) ON CONFLICT (shard_id) DO NOTHING`, [at]);
  await client.query(`INSERT INTO control.space_placement
    (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
    VALUES ($2,'shard-0',1,'active',NULL,'test',$1,$1)`, [at, spaceId]);
}

/** A bounded authority for catalog/message integration tests with slower CI connections. */
export function integrationAuthority() {
  return createAuthorityDatabase({ connectionString, shardId: "shard-0", connectTimeoutMs: 60_000,
    statementTimeoutMs: 10_000, transactionTimeoutMs: 20_000 });
}

/** Migration row limits reject the rewrite inside the original rollback boundary. */
export async function assertMigrationTooLarge(client, migration, countSql) {
  await client.query("BEGIN");
  await assert.rejects(client.query(migration), /exceeds 100000/);
  await client.query("ROLLBACK");
  assert.equal((await client.query(countSql)).rows[0].n, 100001);
}

/** A subscribed open Channel for testing provider room grant routing on the actual authority. */
export async function connectorSubscriptionChannel(sql, spaceId, index, providerId) {
  const channelId = `${spaceId}:channel-${index}`;
  await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
    VALUES ($1,$2,'channel','channel-'||$3,'open',$1||':rank',1,now(),now())`, [channelId, spaceId, String(index)]);
  await sql(`INSERT INTO data.app_source_relations(relation_id,connection_id,space_id,channel_id,source_kind,source_ref,
    features_json,version,created_by,created_at,updated_at)
    VALUES ($1||':relation',$2||':'||$3,$2,$1,'repository',$3||':*','["messages"]',1,'owner',now(),now())`,
    [channelId, spaceId, providerId]);
  return channelId;
}

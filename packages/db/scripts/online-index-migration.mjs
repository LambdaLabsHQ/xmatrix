import { createHash } from "node:crypto";
import { parse } from "libpg-query";
import { setTimeout } from "node:timers/promises";
import { withClientTransaction } from "./cli.mjs";

const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
const digest = text => createHash("sha256").update(text).digest("hex");
const qualified = (schema, name) => `"${schema}"."${name}"`;

/** A blocked SELECT would retain a snapshot that CREATE INDEX CONCURRENTLY needs to drain. */
export async function acquireMigrationLock(client, kind = "transaction") {
  const acquire = kind === "session" ? "pg_try_advisory_lock" : "pg_try_advisory_xact_lock";
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await client.query(`SELECT ${acquire}(hashtextextended('xmatrix-postgres-migrations',0)) AS acquired`);
    if (rows[0].acquired) return;
    if (Date.now() >= deadline) throw Object.assign(new Error("Migration lock acquisition timed out"), { code: "55P03" });
    await setTimeout(50);
  }
}

/** An explicit expand-only mode, parsed by PostgreSQL rather than split on semicolons. */
export async function onlineIndexStatements(source, phase) {
  if (!source.startsWith("-- xmatrix:online-indexes\n")) {
    if (/\bINDEX\s+CONCURRENTLY\b/iu.test(source)) throw new Error("Concurrent indexes require online-indexes mode");
    return null;
  }
  const { stmts } = await parse(source);
  if (phase !== "expand" || !stmts?.length || stmts.length > 8) throw new Error("Online indexes require a bounded expand migration");
  const bytes = Buffer.from(source);
  const names = new Set();
  return stmts.map(raw => {
    const index = raw.stmt.IndexStmt;
    const schema = index?.relation?.schemaname, table = index?.relation?.relname, name = index?.idxname;
    if (!index?.concurrent || index.unique || index.primary || index.if_not_exists ||
        ![schema, table, name].every(value => typeof value === "string" && identifier.test(value)) ||
        !["control", "data"].includes(schema) || names.has(`${schema}.${name}`)) {
      throw new Error("Online migrations allow only named, non-unique CREATE INDEX CONCURRENTLY statements");
    }
    names.add(`${schema}.${name}`);
    const start = raw.stmt_location ?? 0;
    const text = bytes.subarray(start, raw.stmt_len ? start + raw.stmt_len : bytes.length).toString("utf8");
    return { schema, table, name, text, checksum: digest(text) };
  });
}

async function inspect(client, index) {
  const { rows } = await client.query(`SELECT c.oid,i.indisvalid,i.indisready,i.indisunique,
    i.indisexclusion,i.indrelid=to_regclass($2) AS target_matches,
    obj_description(c.oid,'pg_class') AS marker FROM pg_class c
    JOIN pg_index i ON i.indexrelid=c.oid WHERE c.oid=to_regclass($1)`,
  [qualified(index.schema, index.name), qualified(index.schema, index.table)]);
  return rows[0];
}

/** Caller holds the same migration advisory lock for the entire online build and final ledger commit. */
export async function buildOnlineIndexes(client, migration) {
  for (const index of migration.onlineIndexes) {
    let existing;
    const marker = `xmatrix:${migration.id}:${migration.checksumSha256}:${index.checksum}`;
    await withClientTransaction(client, async () => {
      const { rows: intents } = await client.query(`SELECT migration_id,checksum_sha256,statement_sha256,
        table_schema,table_name FROM control.schema_migration_index_builds
        WHERE index_schema=$1 AND index_name=$2 FOR UPDATE`, [index.schema, index.name]);
      existing = await inspect(client, index);
      const intent = intents[0];
      if (intent) {
        if (intent.migration_id !== migration.id || intent.checksum_sha256 !== migration.checksumSha256 ||
            intent.statement_sha256 !== index.checksum || intent.table_schema !== index.schema || intent.table_name !== index.table) {
          throw new Error(`Online index intent differs: ${index.schema}.${index.name}`);
        }
      } else {
        // A durable reservation of an absent name proves ownership after a
        // crash between CREATE's internal commits and our completion marker.
        const { rows } = await client.query("SELECT to_regclass($1) AS object", [qualified(index.schema, index.name)]);
        if (rows[0].object) throw new Error(`Online index name is already owned: ${index.schema}.${index.name}`);
        await client.query(`INSERT INTO control.schema_migration_index_builds
          (index_schema,index_name,migration_id,checksum_sha256,statement_sha256,table_schema,table_name)
          VALUES($1,$2,$3,$4,$5,$1,$6)`,
        [index.schema, index.name, migration.id, migration.checksumSha256, index.checksum, index.table]);
      }
      if (existing && (!existing.target_matches || existing.indisunique || existing.indisexclusion ||
          existing.marker && existing.marker !== marker)) {
        throw new Error(`Online index target differs: ${index.schema}.${index.name}`);
      }
    });
    if (existing?.indisvalid && existing.indisready && existing.marker === marker) continue;
    // Only this exact durable intent may retire its incomplete, unmarked
    // index. Never adopt an unknown definition or use IF NOT EXISTS.
    await client.query("SET statement_timeout='600s'");
    try {
      const query = text => client.query({ text, query_timeout: 605_000 });
      if (existing) await query(`DROP INDEX CONCURRENTLY ${qualified(index.schema, index.name)}`);
      await query(index.text);
      const built = await inspect(client, index);
      if (!built?.indisvalid || !built.indisready || !built.target_matches) throw new Error("Online index is not ready");
      await client.query(`COMMENT ON INDEX ${qualified(index.schema, index.name)} IS '${marker}'`);
    } finally { await client.query("SET statement_timeout='25s'"); }
  }
}

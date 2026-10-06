import { PostgresAutomationRepository } from "../../../db/src/automation-control.ts";
// A scratch PostgreSQL database beside the test database, holding only the
// canonical tables and migrations a test names.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

function migration(file) {
  return readFile(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8");
}

/**
 * Run `body` against a fresh database on `connectionString`'s server, through
 * two connections (one for concurrent statements); the database is dropped
 * afterwards.
 */
export async function withScratchDatabase(connectionString, prefix, body) {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  let client, concurrent, created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    client = new Client({ connectionString: url.toString() });
    concurrent = new Client({ connectionString: url.toString() });
    await client.connect();
    await concurrent.connect();
    return await body({ client, concurrent, url: url.toString() });
  } finally {
    await concurrent?.end();
    await client?.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}

/** Create each table exactly as the expand migration that introduced it declares it. */
export async function createCanonicalTables(client, tablesByMigration) {
  for (const [file, tables] of tablesByMigration) {
    const sql = await migration(file);
    for (const table of tables) {
      const statement = sql.match(new RegExp(`CREATE TABLE data\\.${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(statement, `canonical ${table} schema`);
      await client.query(statement[0]);
    }
  }
  // The 0080 contract renames the Automation tables' indexes too, so create them as 0009 does.
  const automationIndexes = (await migration("0009_expand_remaining_control_facts.sql"))
    .match(/CREATE INDEX scheduled_task\w+\s+ON data\.scheduled_task\w+ \([^)]*\);/gu);
  assert.equal(automationIndexes.length, 3);
  for (const index of automationIndexes) await client.query(index);
}

export async function applyMigrations(client, files) {
  for (const file of files) await client.query(await migration(file));
}

/** The live Automation repository over one scratch connection's commit/rollback boundary. */
export function scratchAutomationRepository(connection) {
  return new PostgresAutomationRepository({ cacheMode: "disabled", async transaction(_, body) {
    await connection.query("BEGIN");
    try {
      const result = await body({ query: async query => (await connection.query(query.text, query.values)).rows });
      await connection.query("COMMIT");
      return result;
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
  } });
}

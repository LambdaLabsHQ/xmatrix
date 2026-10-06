#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executableSql } from "../packages/db/scripts/sql-source.mjs";

const destructivePatterns = [
  /\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/iu,
  /\bTRUNCATE\b/iu,
  /\bDELETE\s+FROM\b/iu,
  /\bUPDATE\s+(?!ON\b)["`[]?[A-Za-z_]/iu,
  /\bPRAGMA\s+(?:writable_schema|legacy_alter_table)\b/iu,
  /\bVACUUM\b/iu,
];



export function assertExpandOnlyMigration(source, name = "migration") {
  const sql = executableSql(source);
  for (const pattern of destructivePatterns) {
    if (pattern.test(sql)) {
      throw new Error(`${name} is not expand-only; matched ${pattern}`);
    }
  }
  for (const statement of sql.split(";")) {
    if (/\bALTER\s+TABLE\b/iu.test(statement) && !/\bADD\s+COLUMN\b/iu.test(statement)) {
      throw new Error(`${name} is not expand-only; ALTER TABLE must only ADD COLUMN`);
    }
  }
}

if (process.argv[1]?.endsWith("d1-expand-only-migration-policy.mjs")) {
  const directory = resolve(process.argv[2] || "packages/hub/migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (names.length === 0) throw new Error(`No D1 migrations found in ${directory}`);
  for (const name of names) {
    assertExpandOnlyMigration(await readFile(resolve(directory, name), "utf8"), name);
  }
  process.stdout.write(`Validated ${names.length} expand-only D1 migration(s).\n`);
}

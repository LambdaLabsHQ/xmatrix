#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runIfInvoked } from "./cli.mjs";
import { relationStatements } from "./migration-relations.mjs";

// A contract migration is applied while the Hub of an earlier release still
// serves. A table it drops or renames must already be gone from that Hub's
// runtime source, so ship the code that stops using it first, then the drop.
const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const RUNTIME_SOURCE = ["packages/*/src/**", ":!**/*.test.*", ":!**/test/**"];

/** Tables a migration's SQL drops or renames away. */
export function removedTables(sql) {
  return [...relationStatements(sql)].flatMap(({ droppedTable, renamed }) => droppedTable ?? renamed ?? []);
}

const EDGE = "([^A-Za-z0-9_]|$)";
const START = "(^|[^A-Za-z0-9_])";

/**
 * Patterns for the ways runtime code reaches a table. No Hub pool sets a
 * search_path, so SQL reaches `data.x` only by naming it with its schema
 * (`data.x`, `"data"."x"`) or by interpolating a string that holds the bare
 * name (`data.${table}` with `table: "x"`). A bare word is not a reference: a
 * route such as `/api/automations` or a field `{ automations: [] }` shares the
 * name and touches no table. A name the migration gives without a schema is
 * matched as any bare word, as before.
 */
export function readerPatterns(table) {
  const [schema, name] = table.includes(".") ? table.split(".") : [null, table];
  if (!schema) return [`${START}${name}${EDGE}`];
  return [`${START}"?${schema}"?\\."?${name}"?${EDGE}`, `["'\`]${name}["'\`]`];
}

/** Runtime source lines at `ref` that still name one of `tables`. */
export function runtimeReaders(ref, tables) {
  if (tables.length === 0) return [];
  const patterns = tables.flatMap((table) => readerPatterns(table).flatMap((pattern) => ["-e", pattern]));
  try {
    return execFileSync("git", ["grep", "-n", "-E", ...patterns, ref, "--", ...RUNTIME_SOURCE],
      { cwd: REPOSITORY, encoding: "utf8" }).trim().split("\n");
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

async function main() {
  const [migrationId, ref] = process.argv.slice(2);
  if (!migrationId || !ref) throw new Error("usage: contract-readers.mjs <migration_id> <deployed hub ref>");
  const sql = await readFile(new URL(`../migrations/${migrationId}.sql`, import.meta.url), "utf8");
  const readers = runtimeReaders(ref, removedTables(sql));
  if (readers.length > 0) {
    throw new Error(`${ref} still uses tables ${migrationId} removes; release the code that stops using them first:\n${readers.join("\n")}`);
  }
}

runIfInvoked(import.meta.url, main);

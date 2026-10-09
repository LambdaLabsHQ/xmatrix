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

/** Runtime source lines at `ref` that still name one of `tables`. */
export function runtimeReaders(ref, tables) {
  if (tables.length === 0) return [];
  const patterns = tables.flatMap((table) => ["-e", table.split(".")[1]]);
  try {
    return execFileSync("git", ["grep", "-n", "-w", ...patterns, ref, "--", ...RUNTIME_SOURCE],
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

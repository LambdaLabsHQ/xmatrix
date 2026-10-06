import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Work belongs to the entity it concerns (docs/architecture/entity-coordinators.md).
 * A Durable Object addressed by a constant name is one object for the whole
 * system; three such coordinators appeared during the PostgreSQL cutover
 * without anything objecting. Every constant-named address is listed here
 * with its reason, and a new one fails until it is reviewed.
 */
const REVIEWED = new Map([
  ['"default"', "Device authorization broker: one OAuth device flow table by nature."],
  ["RELAY_CONTROL_PLANE_RETIREMENT_MANIFEST_OBJECT_NAME", "Immutable retirement manifest; read-only, holds no work."],
  ["RELAY_RANK_AUTHORITY_DIRECTORY_OBJECT_NAME", "Rank authority directory: a lookup table, holds no work."],
  ["RELAY_RUNTIME_SINGLE_CELL_NAME", "Runtime single cell: known global, tracked separately; not a work coordinator."],
]);

async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sources(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${dir}/${entry.name}`] : []));
  return files.flat();
}

test("no Durable Object is addressed by a new constant name", async () => {
  const root = new URL("../src", import.meta.url).pathname;
  const found = [];
  for (const file of await sources(root)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\.idFromName\(\s*("[^"]*"|'[^']*'|`[^`$]*`|[A-Z][A-Z0-9_]{2,})/gu)) {
      if (!REVIEWED.has(match[1])) found.push(`${file.slice(root.length + 1)}: ${match[1]}`);
    }
  }
  assert.deepEqual(found, [], "A constant-named Durable Object is a global coordinator; own the work per entity instead");
});

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// The Worker is one bundle. A runtime `import("./…")` makes esbuild initialize
// that subgraph lazily, and modules outside it (better-auth's zod schemas) then
// depend on incidental evaluation order: a harmless import change once left a
// zod class undefined at load ("Class2 is not a constructor").
test("Hub source loads internal modules statically", async () => {
  const offenders = [];
  for (const file of await sources(SRC.pathname)) {
    const text = await readFile(file, "utf8");
    if (/\bawait\s+import\(\s*["']\.{1,2}\//u.test(text)) offenders.push(file.slice(SRC.pathname.length));
  }
  assert.deepEqual(offenders, []);
});

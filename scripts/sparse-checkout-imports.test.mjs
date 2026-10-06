import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = join(root, ".github/workflows");

function localImports(file) {
  const source = readFileSync(join(root, file), "utf8");
  return [...source.matchAll(/^\s*import\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gmu)]
    .map(match => normalize(join(dirname(file), match[1])));
}

// A sparse checkout that names a script must also name every script it
// imports; otherwise the job dies with ERR_MODULE_NOT_FOUND (cli-release,
// 0.16.344, after production-release-policy.mjs began importing release-commit.mjs).
test("sparse checkouts carry the local imports of every script they list", () => {
  for (const name of readdirSync(workflows).filter(file => file.endsWith(".yml"))) {
    const text = readFileSync(join(workflows, name), "utf8");
    for (const block of text.matchAll(/sparse-checkout: \|\n((?:[ \t]+\S.*\n)+)/gu)) {
      const listed = new Set(block[1].split("\n").map(line => line.trim()).filter(Boolean));
      const pending = [...listed].filter(path => path.endsWith(".mjs"));
      const seen = new Set();
      while (pending.length) {
        const file = pending.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        for (const imported of localImports(file)) {
          assert.ok(listed.has(imported), `${name}: ${file} imports ${imported}, which the sparse checkout omits`);
          pending.push(imported);
        }
      }
    }
  }
});

// Release runners are persistent, and the next job's checkout keeps a sparse
// cone left behind when HEAD is already on its ref (0.16.767's CLI stage lost
// scripts/ to the secrets copy's one-file cone). A job that narrows the tree
// widens it again, whatever happened in between.
test("a sparse checkout is restored to the full tree before its job ends", () => {
  for (const name of readdirSync(workflows).filter(file => file.endsWith(".yml"))) {
    const text = readFileSync(join(workflows, name), "utf8");
    const sparse = text.search(/^\s+sparse-checkout: /mu);
    if (sparse < 0) continue;
    const restore = text.indexOf("name: Restore full checkout after stale sparse state", sparse);
    assert.ok(restore > sparse, `${name}: the sparse checkout is never restored`);
    const step = text.slice(restore, text.indexOf("git read-tree -mu HEAD", restore));
    assert.match(step, /if: always\(\)/u, `${name}: the restore must run even when the job fails`);
  }
});

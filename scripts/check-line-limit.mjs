#!/usr/bin/env node
/**
 * Fail if any tracked source file exceeds 5000 lines.
 * Scopes: ts/tsx/js/mjs/cjs/rs. Skips vendor/generated build outputs only.
 */
import fs from "node:fs";
import path from "node:path";

const LIMIT = 5000;
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  ".next",
  ".git",
  "__pycache__",
  ".pnpm",
  "coverage",
  "artifacts",
  "vendor",
  "generated",
]);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|rs)$/u;
const over = [];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    if (ent.name.startsWith(".") && ent.isDirectory()) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p);
      continue;
    }
    if (!SOURCE_EXT.test(ent.name)) continue;
    if (ent.name.endsWith(".d.ts")) continue;
    const n = fs.readFileSync(p, "utf8").split(/\n/).length;
    if (n > LIMIT) over.push({ n, p });
  }
}

walk(".");
if (over.length) {
  over.sort((a, b) => b.n - a.n);
  for (const o of over) console.error(o.n, o.p);
  console.error(
    "Required remediation: make a responsibility split, not a trim. Every resulting file must be under 2500 lines; see docs/guardrails/project-guardrails.md.",
  );
  process.exit(1);
}
console.log("OK: no source files exceed", LIMIT, "lines");

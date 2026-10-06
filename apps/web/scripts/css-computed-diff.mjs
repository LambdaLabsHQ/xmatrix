#!/usr/bin/env node
/**
 * Compare computed-style snapshots of two builds (see e2e/computed-style-dump.ts).
 *
 *   node scripts/css-computed-diff.mjs <base-1> <base-2> <change-1> <change-2>
 *
 * Each argument is a CSS_DUMP_DIR from one full e2e run. Two runs per build
 * separate a real change from a page that is not deterministic: an element
 * counts as changed only when both runs of the base agree, both runs of the
 * change agree, and the two builds disagree. Exits 1 when anything changed,
 * listing the affected tests and elements.
 */
import fs from "node:fs";
import path from "node:path";

const directories = process.argv.slice(2);
if (directories.length !== 4) {
  console.error("usage: css-computed-diff.mjs <base-1> <base-2> <change-1> <change-2>");
  process.exit(2);
}
const [base, baseAgain, change, changeAgain] = directories;
const read = (directory, file) => {
  const target = path.join(directory, file);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null;
};

let compared = 0;
const changed = [];
for (const file of fs.readdirSync(base).filter((name) => name.endsWith(".json")).sort()) {
  const snapshots = [base, baseAgain, change, changeAgain].map((directory) => read(directory, file));
  if (snapshots.some((snapshot) => snapshot === null)) continue;
  compared += 1;
  const [a, a2, b, b2] = snapshots;
  for (const element of Object.keys(a)) {
    const value = (snapshot) => JSON.stringify(snapshot[element]);
    if (value(a) === value(a2) && value(b) === value(b2) && value(a) !== value(b)) {
      changed.push(`${file.replace(/\.json$/, "")}  ${element}`);
    }
  }
}
console.log(`${compared} tests compared, ${changed.length} elements changed`);
for (const line of changed.slice(0, 200)) console.log(`  ${line}`);
process.exit(changed.length ? 1 : 0);

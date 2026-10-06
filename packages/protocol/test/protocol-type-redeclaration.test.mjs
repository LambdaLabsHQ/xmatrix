import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

// A type protocol exports is the one definition every package reads. A package
// may extend it (`interface X extends ProtocolX`), never declare its own copy.
test("no package redeclares a type protocol exports", () => {
  const root = new URL("../../../", import.meta.url);
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const path = new URL(name, dir);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || name === "dist" ? [] : files(new URL(`${name}/`, dir));
    }
    return /\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) ? [path] : [];
  });
  const declared = /^export (?:interface|type) ([A-Z]\w*)/gmu;
  const protocolTypes = new Set(files(new URL("packages/protocol/src/", root))
    .flatMap((path) => [...readFileSync(path, "utf8").matchAll(declared)].map((match) => match[1])));
  const offenders = [];
  for (const dir of ["packages/db/src/", "packages/hub/src/", "apps/web/src/"]) {
    for (const path of files(new URL(dir, root))) {
      for (const match of readFileSync(path, "utf8").matchAll(/^(?:export )?(?:interface|type) ([A-Z]\w*)([^\n]*)/gmu)) {
        if (protocolTypes.has(match[1]) && !match[2].includes(`extends Protocol${match[1]}`)) {
          offenders.push(`${path.pathname.slice(root.pathname.length)}: ${match[1]}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "import the type from @xmatrix/protocol, or extend it");
});

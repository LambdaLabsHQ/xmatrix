import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";
import { sourceOffenders } from "./repository-sources.mjs";

const { canonicalJsonStringify } = await loadTypescriptModule(
  new URL("../src/relay-v2/canonical-json.ts", import.meta.url),
);

test("canonical JSON sorts keys by code unit and refuses what JSON cannot carry", () => {
  assert.equal(canonicalJsonStringify({ b: 1, B: [true, null], a: { z: "x", _: 0 } }),
    '{"B":[true,null],"a":{"_":0,"z":"x"},"b":1}');
  assert.equal(canonicalJsonStringify("é"), '"é"');
  for (const value of [undefined, { a: undefined }, [undefined], () => 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => canonicalJsonStringify(value));
  }
});

// Copies whose output differs from the shared one on some input. Each writes
// digests or archives already stored, so it changes only with a format bump.
const DIVERGENT = new Set([
  "packages/db/src/user-preferences.ts", // localeCompare key order
  "packages/hub/src/runtime-transport/authorized-projection-history.ts", // localeCompare key order
]);

test("no package writes another canonical JSON serializer", () => {
  const offenders = sourceOffenders(
    ["packages/protocol/src/", "packages/db/src/", "packages/hub/src/", "apps/web/src/", "apps/desktop/src/"],
    (source, relative) => /function canonicalJson\s*\(/u.test(source) && !DIVERGENT.has(relative));
  assert.deepEqual(offenders, [], "use canonicalJsonStringify from @xmatrix/protocol");
});

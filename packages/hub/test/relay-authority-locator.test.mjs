import { hubTypeScriptFiles } from "./support/hub-source.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  relayRuntimeCellNamed,
  relayRuntimeSingleCell,
  RELAY_RUNTIME_SINGLE_CELL_NAME,
} from "../src/relay-authority-locator.ts";

function recordingNamespace() {
  const resolved = [];
  return {
    resolved,
    idFromName: (name) => ({ name }),
    get: (id, options) => {
      resolved.push({ name: id.name, ...(options ? { options } : {}) });
      return { stubFor: id.name };
    },
  };
}

test("the Runtime resolver hands back the namespace's fixed-cell stub", () => {
  const RELAY_RUNTIME = recordingNamespace();
  assert.deepEqual(
    relayRuntimeSingleCell({ RELAY_RUNTIME }),
    { stubFor: RELAY_RUNTIME_SINGLE_CELL_NAME },
  );
  assert.deepEqual(RELAY_RUNTIME.resolved, [{ name: RELAY_RUNTIME_SINGLE_CELL_NAME }]);
});

test("a configured location creates every Runtime cell there under a location-scoped name", () => {
  const RELAY_RUNTIME = recordingNamespace();
  const env = { RELAY_RUNTIME, XMATRIX_RUNTIME_LOCATION_HINT: "apac" };
  relayRuntimeSingleCell(env);
  relayRuntimeCellNamed(env, "cell-v1-03");
  assert.deepEqual(RELAY_RUNTIME.resolved, [
    { name: "cell-0@apac", options: { locationHint: "apac" } },
    { name: "cell-v1-03@apac", options: { locationHint: "apac" } },
  ]);
});

test("an unknown Runtime location fails closed instead of creating a cell anywhere", () => {
  const RELAY_RUNTIME = recordingNamespace();
  assert.throws(
    () => relayRuntimeSingleCell({ RELAY_RUNTIME, XMATRIX_RUNTIME_LOCATION_HINT: "singapore" }),
    /location hint/u,
  );
  assert.deepEqual(RELAY_RUNTIME.resolved, []);
});

/**
 * The retired Authority singleton must not be addressable anywhere in production
 * source. Runtime keeps its independent fixed-cell resolver.
 */
test("no source resolves the retired authority or Runtime cell by raw name", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders = [];
  for (const path of hubTypeScriptFiles(srcRoot)) {
    if (path.endsWith("/relay-authority-locator.ts")) continue;
  const source = readFileSync(path, "utf8");
  if (/RELAY_CORE\s*\.\s*(?:idFromName|get)\(/u.test(source) ||
      /RELAY_AUTHORITY_SINGLE_AUTHORITY_NAME|relayAuthorityAuthority(?:Name)?\(/u.test(source) ||
      /idFromName\(\s*"cell-0"\s*\)/u.test(source)) {
    offenders.push(relative(srcRoot, path));
  }
  }
  assert.deepEqual(offenders, [], "route product authority through the post-retirement directory");
});

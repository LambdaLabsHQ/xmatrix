import assert from "node:assert/strict";
import { sourceText, sourceFiles } from "./source-file.fixture.mjs";
import { test } from "node:test";

const OWNER = "command-digest.ts";

test("one command digest canonicalizer serves every db command authority", () => {
  const offenders = sourceFiles()
    .filter((name) => name.endsWith(".ts") && name !== OWNER)
    .filter((name) => {
      const text = sourceText(name);
      return text.includes('return JSON.stringify(value);') && text.includes('value.map(stable).join(",")');
    });
  assert.deepEqual(offenders, [],
    "read commandJson/commandDigest from command-digest.ts instead of re-declaring localeCompare JSON");
  const shared = sourceText(OWNER);
  assert.match(shared, /export function commandJson\(/u);
  assert.match(shared, /export async function commandDigest\(/u);
});

test("a command hashes the same before and after its jsonb round trip", async () => {
  const { commandDigest, commandJson } = await import("../dist/command-digest.js");
  const issued = { payload: { registration: { runId: "run", runtimeModel: undefined }, slots: [1, undefined] } };
  const stored = JSON.parse(JSON.stringify(issued));
  assert.equal(commandJson(issued), JSON.stringify(stored));
  assert.equal(await commandDigest(issued), await commandDigest(stored));
});

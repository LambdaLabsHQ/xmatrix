import assert from "node:assert/strict";
import { test } from "node:test";

test("a command hashes the same before and after its jsonb round trip", async () => {
  const { commandDigest, commandJson } = await import("../dist/command-digest.js");
  const issued = { payload: { registration: { runId: "run", runtimeModel: undefined }, slots: [1, undefined] } };
  const stored = JSON.parse(JSON.stringify(issued));
  assert.equal(commandJson(issued), JSON.stringify(stored));
  assert.equal(await commandDigest(issued), await commandDigest(stored));
});

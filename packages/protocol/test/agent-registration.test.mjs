import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentRegistrationKey, parseSpaceAgentRegistrationKey, sameAgentRegistration } from "../dist/agent-registration.js";

const key = { ownerUserId: "owner-a", machineId: "machine-a", harness: "codex" };

test("Space configurations share execution identity without sharing configuration scope", () => {
  const a = parseSpaceAgentRegistrationKey({ ...key, spaceId: "space-a" });
  const b = parseSpaceAgentRegistrationKey({ ...key, spaceId: "space-b" });
  assert.equal(sameAgentRegistration(a, b), true);
  assert.notDeepEqual(a, b);
  assert.throws(() => parseSpaceAgentRegistrationKey(key));
  assert.throws(() => parseSpaceAgentRegistrationKey({ ...a, configurationId: "extra" }));
});

test("registration is exactly owner, machine and harness", () => {
  assert.deepEqual(parseAgentRegistrationKey(key), key);
  for (const field of ["id", "profileId", "uuid", "configId", "spaceId", "name", "runId"]) {
    assert.throws(() => parseAgentRegistrationKey({ ...key, [field]: "another" }), /extra identity dimension/);
  }
  for (const field of Object.keys(key)) {
    const other = { ...key, [field]: `${key[field]}-other` };
    assert.equal(sameAgentRegistration(key, other), false);
  }
  assert.equal(sameAgentRegistration(key, { ...key }), true);
});

test("legacy harness aliases cannot create duplicate natural identities", () => {
  for (const [alias, canonical] of [["claude_code", "claude"], ["cursor-agent", "cursor"],
    ["codex.exe", "codex"], ["C:\\tools\\codex.cmd", "codex"]]) {
    assert.deepEqual(parseAgentRegistrationKey({ ...key, harness: alias }), { ...key, harness: canonical });
  }
});

test("missing identity never falls back to a name or generated identifier", () => {
  for (const invalid of [null, [], {}, { ...key, machineId: "" }, { ...key, ownerUserId: " owner-a" },
    { ...key, machineId: "machine\n-a" }, { ...key, harness: "custom" },
    { ...key, harness: "unknown/path" }, { ...key, machineId: "m".repeat(301) }]) {
    assert.throws(() => parseAgentRegistrationKey(invalid));
  }
});

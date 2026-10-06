import assert from "node:assert/strict";
import test from "node:test";
import { parseRegistrationLaunchBinding, registrationLaunchBindingForDaemon } from "../dist/agent-registration-launch.js";
const binding = { schemaVersion: 1, key: { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" },
  runId: "run", instanceId: "instance", allocationId: "allocation", authorizationDigest: "a".repeat(64), environmentVersion: 1, runtimeModel: "provider/model",
  resources: { workspaces: ["repo"], models: ["model"], capabilities: [] } };

test("launch bindings carry natural registration and exact execution identities without local executable authority", () => {
  assert.deepEqual(parseRegistrationLaunchBinding(binding), binding);
  for (const field of ["runtime", "env", "agentId", "profileId", "backend", "sandboxMode"]) {
    assert.throws(() => parseRegistrationLaunchBinding({ ...binding, [field]: "injected" }));
  }
  for (const key of [{ ...binding.key, configurationId: "extra" }, { ...binding.key, ownerUserId: "" }]) {
    assert.throws(() => parseRegistrationLaunchBinding({ ...binding, key }));
  }
});

test("launch bindings reject broad resource sets, unversioned declarations and missing execution fences", () => {
  for (const patch of [{ schemaVersion: 2 }, { runId: " " }, { instanceId: "" }, { allocationId: null },
    { authorizationDigest: "invalid" }, { environmentVersion: 0 }, { environmentVersion: Number.MAX_SAFE_INTEGER + 1 },
    { resources: { ...binding.resources, workspaces: ["repo", "other"] } },
    { resources: { ...binding.resources, models: ["model", "other"] } }]) {
    assert.throws(() => parseRegistrationLaunchBinding({ ...binding, ...patch }));
  }
});

test("a launch binding with no workspace is a private managed directory", () => {
  const managed = { ...binding, resources: { ...binding.resources, workspaces: [] } };
  assert.deepEqual(parseRegistrationLaunchBinding(managed), managed);
});

test("daemons that require resources.secrets receive it empty, and their echo parses back", () => {
  const sent = registrationLaunchBindingForDaemon(binding);
  assert.deepEqual(sent.resources.secrets, []);
  assert.deepEqual(parseRegistrationLaunchBinding(sent), binding);
});

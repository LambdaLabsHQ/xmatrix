import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentEnvironmentCommand } from "../dist/agent-registration-environment.js";

const command = { key: { ownerUserId: "owner", machineId: "machine", harness: "claude_code" }, commandId: "update",
  expectedVersion: 0, expectedMachineVersion: 0, machineMaxConcurrent: 2,
  environment: { schemaVersion: 1, enabled: true, models: ["model"], modelAliases: { model: "provider/model" },
    description: "Interactive browser", availability: "interactive", maxConcurrent: 1, capabilities: [] } };

test("owner environment uses the physical triple without a machine concurrency limit", () => {
  const result = parseAgentEnvironmentCommand(command);
  assert.equal(result.key.harness, "claude");
  assert.equal(Object.hasOwn(result, "machineMaxConcurrent"), false);
  assert.equal(Object.hasOwn(result, "expectedMachineVersion"), false);
  assert.equal(result.environment.modelAliases.model, "provider/model");
});

test("Space configuration, credentials and impossible limits cannot enter physical declarations", () => {
  const withUnknown = parseAgentEnvironmentCommand({ ...command, environment: { ...command.environment, secretReferences: ["private-space-secret"] } });
  assert.equal(Object.hasOwn(withUnknown.environment, "secretReferences"), false);
  for (const patch of [{ key: { ...command.key, spaceId: "space" } }, { actorUserId: "owner" },
    { expectedVersion: -1 },
    { environment: { ...command.environment, defaultWorkspace: "/private-space-path" } }]) {
    assert.throws(() => parseAgentEnvironmentCommand({ ...command, ...patch }));
  }
});

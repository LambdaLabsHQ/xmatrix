import assert from "node:assert/strict";
import test from "node:test";
import { parseSpaceAgentConfiguration, spaceConfigurationResources } from "../dist/agent-registration-configuration.js";

const configuration = { model: "model-a", workspaceReferences: ["/project"] };
test("Space configuration contains references and settings, never installation or authority fields", () => {
  assert.deepEqual(parseSpaceAgentConfiguration(configuration), configuration);
  for (const field of ["backend", "executable", "env", "secretValues", "sandboxMode", "ownerUserId", "machineId",
    "grant", "agentRunPermissions", "installation"]) {
    assert.deepEqual(parseSpaceAgentConfiguration({ ...configuration, [field]: "cannot-pass-through" }), configuration);
  }
  assert.throws(() => parseSpaceAgentConfiguration({ ...configuration, workspaceReferences: ["*"] }));
  assert.throws(() => parseSpaceAgentConfiguration({ ...configuration, instructions: "x".repeat(8001) }));
});

test("a configuration stored with a retired Role assignment reads as unassigned, without a diagnostic", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const role = { roleId: "role:reviewer:1", roleVersion: "1.0.0", roleDigest: `sha256:${"a".repeat(64)}` };
  const withInstructions = { ...configuration, instructions: "Review the diff." };
  assert.deepEqual(parseSpaceAgentConfiguration({ ...withInstructions, role }), withInstructions);
  assert.deepEqual(parseSpaceAgentConfiguration({ ...configuration, role: "not-even-an-object" }), configuration);
  assert.equal(warn.mock.callCount(), 0);
});

test("a configuration stored with secret references reads without them: secrets belong to the Space", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(parseSpaceAgentConfiguration({ ...configuration, secretReferences: ["space-secret-ref"] }), configuration);
  assert.equal(warn.mock.callCount(), 0);
});

test("routing defaults cannot escape the Space resource set", () => {
  const routing = { schemaVersion: 1, enabled: true, models: ["model-a"], description: "",
    defaultWorkspace: "/project" };
  assert.deepEqual(spaceConfigurationResources({ ...configuration, routing }), {
    models: ["model-a"], workspaces: ["/project"], capabilities: [],
  });
  assert.throws(() => spaceConfigurationResources({ ...configuration, routing: { ...routing, defaultWorkspace: "/elsewhere" } }));
  for (const ownerFact of [{ availability: "unattended" }, { availableUntil: "2030-01-01T00:00:00Z" },
    { capabilities: [] }, { modelAliases: { "model-a": "ungranted-provider-model" } }]) {
    assert.deepEqual(parseSpaceAgentConfiguration({ ...configuration, routing: { ...routing, ...ownerFact } }), { ...configuration, routing });
  }
});

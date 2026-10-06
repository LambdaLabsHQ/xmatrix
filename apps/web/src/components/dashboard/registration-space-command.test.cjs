const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { registrationEnvironmentCommand, registrationSpaceCommand } = require("./registration-space-command.ts");
const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
const current = { key, version: 8, displayName: "Codex", canConfigureSpace: true,
  configuration: { model: "old", reasoningEffort: "high", instructions: "Inspect the project",
    workspaceReferences: ["repo:owner/project"],
    routing: { enabled: true, models: ["old", "new"] } },
  access: { policy: { revision: 3, limits: { models: ["old", "new"],
    workspaces: ["repo:owner/project"], capabilities: ["browser"] } } } };

test("changing a default model preserves workspaces and routing configuration", () => {
  const value = registrationSpaceCommand(key, current, { kind: "model", model: "new" });
  assert.equal(value.expectedVersion, 8);
  assert.deepEqual(value.configuration, { ...current.configuration, model: "new" });
  assert.equal(current.configuration.model, "old");
});

test("missing or retargeted configuration cannot produce a destructive replacement", () => {
  assert.throws(() => registrationSpaceCommand(key, { ...current, configuration: undefined }, { kind: "model", model: "new" }));
  assert.throws(() => registrationSpaceCommand(key, { ...current, key: { ...key, machineId: "other" } }, { kind: "configure", model: "new" }));
});

test("configuring a name keeps the configuration and renames only the Space's label", () => {
  const value = registrationSpaceCommand(key, current, { kind: "configure", model: "old", displayName: "  Reviewer  " });
  assert.equal(value.action, "configure");
  assert.equal(value.displayName, "Reviewer");
  assert.deepEqual(value.configuration, current.configuration);
  const unnamed = registrationSpaceCommand(key, current, { kind: "configure", model: "" });
  assert.equal(unnamed.displayName, "Codex");
  assert.equal("model" in unnamed.configuration, false);
});

const grant = { state: "active", revision: 5, executionRevision: 5,
  limits: { models: ["old"], workspaces: ["repo:owner/project"], capabilities: [] } };
const owned = { ...current, canManageOwnerGrant: true, canConfigureSpace: false, canRemoveFromSpace: true,
  access: { ...current.access, grant } };

test("an owner adds back an agent removed from the Space, keeping its resources", () => {
  const restored = registrationSpaceCommand(key, owned, { kind: "restore" });
  assert.deepEqual(restored, { key, action: "owner-grant", state: "active", expectedRevision: 5, limits: grant.limits });
  assert.throws(() => registrationSpaceCommand(key, { ...owned, access: null }, { kind: "restore" }));
});

test("a Space admin disables and enables an agent in the Space against its Space revision", () => {
  const admin = { ...owned, canManageOwnerGrant: false, canConfigureSpace: true };
  assert.deepEqual(registrationSpaceCommand(key, admin, { kind: "space-disable" }),
    { key, action: "space-state", state: "disabled", expectedRevision: 3 });
  assert.deepEqual(registrationSpaceCommand(key, admin, { kind: "space-enable" }),
    { key, action: "space-state", state: "enabled", expectedRevision: 3 });
  assert.throws(() => registrationSpaceCommand(key, admin, { kind: "restore" }), /Only the agent's owner can add it back/);
});

test("its owner or a Space owner/admin turns an agent off in the Space; only a Space owner/admin configures it", () => {
  assert.equal(registrationSpaceCommand(key, owned, { kind: "space-disable" }).state, "disabled");
  const member = { ...owned, canManageOwnerGrant: false, canConfigureSpace: false };
  assert.throws(() => registrationSpaceCommand(key, member, { kind: "space-disable" }), /turn it on or off/);
  assert.throws(() => registrationSpaceCommand(key, owned, { kind: "configure", model: "new" }));
});

test("disabling flips only the owner's environment switch, against the version read", () => {
  const environment = { schemaVersion: 1, enabled: true, models: ["old"], description: "", availability: "unknown",
    capabilities: [], launch: { runtime: "codex", runtimeArgs: [] } };
  const physical = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
  const disabled = registrationEnvironmentCommand({ key: physical, version: 4, environment }, { kind: "disable" });
  assert.deepEqual(disabled.key, physical);
  assert.equal(disabled.expectedVersion, 4);
  assert.deepEqual(disabled.environment, { ...environment, enabled: false });
  assert.match(disabled.commandId, /^registration-ui:/u);
  const enabled = registrationEnvironmentCommand({ key: physical, version: 5, environment: disabled.environment }, { kind: "enable" });
  assert.equal(enabled.environment.enabled, true);
  assert.throws(() => registrationEnvironmentCommand({ key: physical, version: 0, environment: null }, { kind: "enable" }),
    /not set up/u);
});

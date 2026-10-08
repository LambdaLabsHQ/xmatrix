const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const compiled = compileTsModules(__dirname, ["harness-space-switch", "my-agents-registrations", "time-display"]);
const { harnessSpaceCreateCommand, harnessSpaceKey, harnessSpaceRegistration, harnessSpaceSwitch,
  harnessTurnsOnAfterInstall } = compiled.exports;

test.after(compiled.dispose);

const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine-1", harness: "codex" };

function registration(overrides = {}) {
  return {
    key, displayName: "codex", ownerName: "Ada", machineName: "Workstation", version: 1, state: "enabled",
    models: [], routingReady: true, canManageOwnerGrant: true, canConfigureSpace: false, canRemoveFromSpace: false,
    ...overrides,
  };
}

test("a harness is found by its machine and harness in the Space, with the owner the machine implies", () => {
  assert.deepEqual(harnessSpaceKey("space", "owner", "machine-1", "codex"), key);
  const other = registration({ key: { ...key, machineId: "machine-2" } });
  const own = registration();
  assert.equal(harnessSpaceRegistration([other, own], key), own);
  assert.equal(harnessSpaceRegistration([other], key), undefined);
  assert.equal(harnessSpaceRegistration(undefined, key), undefined);
});

test("an installed harness the Space has never had is off, and turning it on writes it", () => {
  assert.deepEqual(harnessSpaceSwitch(undefined), { on: false, create: true, changes: [] });
});

test("one its owner removed is off and is written again, which adds it back", () => {
  assert.deepEqual(harnessSpaceSwitch(registration({ state: "revoked" })), { on: false, create: true, changes: [] });
});

test("an existing one flips the same states the Agents page does", () => {
  assert.deepEqual(harnessSpaceSwitch(registration()), { on: true, create: false, changes: ["space-disable"] });
  assert.deepEqual(harnessSpaceSwitch(registration({ state: "disabled" })), { on: false, create: false, changes: ["space-enable"] });
  assert.deepEqual(harnessSpaceSwitch(registration({ routingBlocker: "owner_environment_disabled", routingReady: false })),
    { on: false, create: false, changes: ["enable"] });
});

test("an offer its owner never granted has no switch", () => {
  assert.equal(harnessSpaceSwitch(registration({ state: "unshared" })), null);
});

test("the written registration launches the preset as xmatrix agent add does", () => {
  const command = harnessSpaceCreateCommand(key, { id: "codex", runtime: "codex", defaultArgs: ["--x"], backend: "codex" });
  assert.equal(command.action, "create");
  assert.match(command.commandId, /^registration-create:/u);
  assert.deepEqual(command.key, key);
  assert.equal(command.displayName, "codex");
  assert.deepEqual(command.environment, { schemaVersion: 1, enabled: true, models: [], description: "",
    availability: "unknown", capabilities: [], launch: { runtime: "codex", runtimeArgs: ["--x"], backend: "codex" } });
});

test("only a successful install of a harness the Space never had turns it on", () => {
  const done = { action: "install", status: "succeeded", installed: true };
  assert.equal(harnessTurnsOnAfterInstall(undefined, done), true);
  assert.equal(harnessTurnsOnAfterInstall(registration({ state: "disabled" }), done), false, "a switch turned off stays off");
  assert.equal(harnessTurnsOnAfterInstall(registration({ state: "revoked" }), done), false);
  assert.equal(harnessTurnsOnAfterInstall(undefined, { ...done, status: "failed" }), false);
  assert.equal(harnessTurnsOnAfterInstall(undefined, { ...done, status: "running" }), false);
  assert.equal(harnessTurnsOnAfterInstall(undefined, { ...done, installed: false }), false);
  assert.equal(harnessTurnsOnAfterInstall(undefined, { ...done, action: "update" }), false, "an update is not a first install");
});

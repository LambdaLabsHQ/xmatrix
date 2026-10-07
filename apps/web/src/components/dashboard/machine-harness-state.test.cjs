const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { machineHarnessState, harnessUpdateAvailable, harnessCommandLabel, harnessAutoUpdateSupported } = require("./machine-harness-state.ts");
const { AGENT_PRESETS } = require("@xmatrix/protocol");
const inventory = { schemaVersion: 1, capturedAt: "2026-10-01T08:00:00Z",
  items: [{ id: "codex", installed: true, probeStatus: "ok", version: "1.2.3", latestVersion: "1.3.0", autoUpdate: "enabled" }] };
const daemon = { id: "daemon-a", userId: "owner-a", machineId: "machine-a", status: "online",
  metadata: { platform: "windows", capabilities: ["machine_harness_action_v1"], harnesses: inventory } };

test("only the online owner with a capable daemon sees enabled management", () => {
  assert.equal(machineHarnessState(daemon, "owner-a").canManage, true);
  for (const other of [undefined, "another-owner"]) assert.equal(machineHarnessState(daemon, other).canManage, false);
  for (const changed of [{ status: "offline" }, { machineId: undefined }, { metadata: { capabilities: [] } }]) {
    assert.equal(machineHarnessState({ ...daemon, ...changed }, "owner-a").canManage, false);
  }
  assert.equal(machineHarnessState(undefined, "owner-a").canManage, false);
});
test("inventory preserves real version/update observations, missing rows remain unknown", () => {
  const state = machineHarnessState(daemon, "owner-a");
  assert.equal(state.rows.find(row => row.preset.id === "codex").item.latestVersion, "1.3.0");
  assert.equal(state.rows.find(row => row.preset.id === "claude").item, undefined);
  assert.equal(state.rows.some(row => row.preset.id === "custom"), false);
  assert.equal(machineHarnessState({ ...daemon, metadata: { harnesses: { ...inventory, schemaVersion: 9 } } }).inventory, undefined);
});
test("platform is taken from the daemon, never inferred from a machine name", () => {
  assert.equal(machineHarnessState(daemon).recipePlatform, "windows");
  for (const platform of ["linux", "macos"]) assert.equal(machineHarnessState({ ...daemon, metadata: { platform } }).recipePlatform, "unix");
  assert.equal(machineHarnessState({ ...daemon, hostName: "Windows", metadata: {} }).recipePlatform, undefined);
});
test("unknown, equal, newer and unparseable versions never claim an update exists", () => {
  assert.equal(harnessUpdateAvailable("1.2.3", "1.3.0"), true);
  assert.equal(harnessUpdateAvailable("1.2.3-beta.1", "1.2.3"), true);
  for (const [current, latest] of [["1.2.3", "1.2.3"], ["2.0.0", "1.9.0"], ["preview", "2.0.0"], ["1.0.0", undefined], [undefined, "2.0.0"]]) {
    assert.equal(harnessUpdateAvailable(current, latest), false);
  }
});
test("confirmation displays argv and unsupported automatic controls stay unavailable", () => {
  assert.equal(harnessCommandLabel({ command: "npm", args: ["install", "package name"] }), 'npm install "package name"');
  assert.equal(harnessCommandLabel(null), undefined);
  assert.equal(harnessAutoUpdateSupported(AGENT_PRESETS.find(preset => preset.id === "zcode")), false);
  assert.equal(harnessAutoUpdateSupported(AGENT_PRESETS.find(preset => preset.id === "claude")), true);
});

test("installed harnesses lead and each group keeps catalog order", () => {
  const state = machineHarnessState({ ...daemon, metadata: { ...daemon.metadata, harnesses: { ...inventory, items: [
    ...inventory.items,
    { id: "cursor", installed: true, probeStatus: "ok", version: "1" },
    { id: "claude", installed: false, probeStatus: "missing" },
  ] } } }, "owner-a");
  const installed = state.rows.filter((row) => row.item?.installed).map((row) => row.preset.id);
  const rest = state.rows.filter((row) => !row.item?.installed).map((row) => row.preset.id);
  const catalog = AGENT_PRESETS.filter((preset) => preset.id !== "custom").map((preset) => preset.id);
  assert.deepEqual(state.rows.map((row) => row.preset.id), [...installed, ...rest]);
  assert.deepEqual(installed, catalog.filter((id) => installed.includes(id)));
  assert.deepEqual(rest, catalog.filter((id) => rest.includes(id)));
  assert.ok(installed.includes("codex") && installed.includes("cursor") && rest.includes("claude"));
});

test("Cursor update readiness requires the vendor launcher capability", () => {
  assert.equal(machineHarnessState(daemon, "owner-a").cursorUpdateReady, false);
  assert.equal(machineHarnessState({ ...daemon, metadata: { ...daemon.metadata,
    capabilities: ["machine_harness_action_v1", "machine_harness_cursor_launcher_v1"] } }, "owner-a").cursorUpdateReady, true);
});

test("an online daemon that left work unanswered is flagged but stays manageable", () => {
  const quiet = machineHarnessState({ ...daemon, unansweredSince: "2026-10-07T10:09:00.000Z" }, "owner-a");
  assert.equal(quiet.responding, false);
  assert.equal(quiet.canManage, true);
  assert.equal(machineHarnessState(daemon, "owner-a").responding, true);
});

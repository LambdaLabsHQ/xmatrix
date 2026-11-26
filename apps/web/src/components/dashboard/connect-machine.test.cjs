const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  connectStep, defaultInstallPlatform, setupInstallCommand, setupIntentNeeded,
  setupIntentPollIntervalMs, setupIntentReported, terminalInstallPlatform,
} = require("./connect-machine.ts");

const INTENT = "0123456789abcdef0123456789abcdef";

function status(overrides = {}) {
  return {
    intentId: INTENT, spaceId: "space-1", expiresAt: "2026-10-07T02:00:00.000Z",
    phase: "waiting", registeredHarnesses: [], ...overrides,
  };
}

const connected = (harnesses, registeredHarnesses = []) => status({
  phase: "connected",
  terminal: { userCode: "WDJB-MJHT", hostname: "daniel-laptop" },
  machine: { machineId: "m-1", name: "Laptop", online: true, ...(harnesses ? { harnesses } : {}) },
  registeredHarnesses,
});

test("the command carries only the setup id, per platform", () => {
  assert.equal(setupInstallCommand(INTENT, "unix"),
    `curl -fsSL https://xmatrix.sh/install.sh | bash -s -- --connect ${INTENT}`);
  assert.equal(setupInstallCommand(INTENT, "windows"),
    `$env:XMATRIX_CONNECT='${INTENT}'; irm https://xmatrix.sh/install.ps1 | iex`);
  assert.equal(defaultInstallPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(defaultInstallPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "unix");
});

test("a wait says more only once it has lasted", () => {
  assert.deepEqual(connectStep(status(), 10_000), { kind: "waiting", hint: "none" });
  assert.deepEqual(connectStep(status(), 60_000), { kind: "waiting", hint: "check-terminal" });
  assert.deepEqual(connectStep(status(), 4 * 60_000), { kind: "waiting", hint: "try-desktop" });
});

test("a terminal asks for approval, then signs in, then the machine reports", () => {
  const terminal = { userCode: "WDJB-MJHT", hostname: "daniel-laptop" };
  assert.deepEqual(connectStep(status({ phase: "approval", terminal }), 0),
    { kind: "approval", hostname: "daniel-laptop", userCode: "WDJB-MJHT" });
  assert.deepEqual(connectStep(status({ phase: "connecting", terminal }), 0),
    { kind: "connecting", hostname: "daniel-laptop" });
  assert.deepEqual(connectStep(connected(undefined), 0), { kind: "looking", machineName: "Laptop" });
});

test("the installed harnesses are reported, whatever the Space already has", () => {
  const harnesses = [
    { id: "claude", installed: true, login: "signed_in" },
    { id: "codex", installed: true },
    { id: "gemini", installed: false },
  ];
  const found = connectStep(connected(harnesses, ["claude"]), 0);
  assert.equal(found.kind, "found");
  assert.deepEqual(found.harnesses.map((harness) => harness.id), ["claude", "codex"]);
  assert.deepEqual(connectStep(connected([{ id: "gemini", installed: false }]), 0),
    { kind: "none-installed", machineName: "Laptop" });
});

test("a signed-in terminal's own platform picks the installers it is shown", () => {
  assert.equal(terminalInstallPlatform("windows-x86_64"), "windows");
  assert.equal(terminalInstallPlatform("macos-aarch64"), "unix");
  assert.equal(terminalInstallPlatform("linux-x86_64"), "unix");
  assert.equal(terminalInstallPlatform(undefined), undefined);
});

test("setup intents are only created when a terminal setup command is actually shown", () => {
  const emptyLinux = {
    another: false,
    phone: false,
    appFirst: false,
    platformReady: true,
    catalogSettled: true,
    daemonsSettled: true,
    hasEnabledAgents: false,
    hasInstalledCandidates: false,
  };
  assert.equal(setupIntentNeeded(emptyLinux), true);
  assert.equal(setupIntentNeeded({ ...emptyLinux, phone: true }), false);
  assert.equal(setupIntentNeeded({ ...emptyLinux, platformReady: false }), false);
  assert.equal(setupIntentNeeded({ ...emptyLinux, appFirst: true }), false);
  assert.equal(setupIntentNeeded({ ...emptyLinux, catalogSettled: false }), false);
  assert.equal(setupIntentNeeded({ ...emptyLinux, daemonsSettled: false }), false);
  assert.equal(setupIntentNeeded({ ...emptyLinux, hasEnabledAgents: true }), false);
  assert.equal(setupIntentNeeded({ ...emptyLinux, hasInstalledCandidates: true }), false);
  // Adding another machine explicitly asks for a setup command even when the Space already has agents.
  assert.equal(setupIntentNeeded({
    ...emptyLinux, another: true, appFirst: true, hasEnabledAgents: true, hasInstalledCandidates: true,
  }), true);
  assert.equal(setupIntentNeeded({ ...emptyLinux, another: true, phone: true }), false);
});

test("setup intent polling backs off while waiting idle, stays fast once active, and stops when reported", () => {
  const waiting = status({ phase: "waiting" });
  assert.equal(setupIntentPollIntervalMs(undefined, 0), 2_000);
  assert.equal(setupIntentPollIntervalMs(waiting, 60_000), 2_000);
  assert.equal(setupIntentPollIntervalMs(waiting, 2 * 60_000), 5_000);
  assert.equal(setupIntentPollIntervalMs(waiting, 10 * 60_000), 15_000);

  const terminal = { userCode: "WDJB-MJHT", hostname: "daniel-laptop" };
  assert.equal(setupIntentPollIntervalMs(status({ phase: "approval", terminal }), 20 * 60_000), 2_000);
  assert.equal(setupIntentPollIntervalMs(status({ phase: "connecting", terminal }), 20 * 60_000), 2_000);
  assert.equal(setupIntentPollIntervalMs(connected([{ id: "gemini", installed: false }]), 20 * 60_000), 2_000);
  assert.equal(setupIntentReported(connected([{ id: "claude", installed: true }])), true);
  assert.equal(setupIntentPollIntervalMs(connected([{ id: "claude", installed: true }]), 1_000), false);
});

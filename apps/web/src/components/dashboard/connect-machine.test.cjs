const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  connectStep, defaultInstallPlatform, listNames, setupInstallCommand,
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

test("names read as a sentence", () => {
  assert.equal(listNames(["Claude Code"]), "Claude Code");
  assert.equal(listNames(["Claude Code", "Codex"]), "Claude Code and Codex");
  assert.equal(listNames(["Claude Code", "Codex", "Gemini"]), "Claude Code, Codex and Gemini");
});

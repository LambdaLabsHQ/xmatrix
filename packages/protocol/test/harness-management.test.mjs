import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_PRESETS, harnessActionAvailable, harnessOutputTail, parseHarnessActionRequest, parseHarnessActionResult,
  parseHarnessInventory } from "../dist/index.js";

const inventory = { schemaVersion: 1, capturedAt: "2026-09-30T12:00:00Z",
  items: [{ id: "codex", installed: true, path: "C:\\bin\\codex.cmd", version: "1.2.3", probeStatus: "ok" }] };

test("inventory validates bounds and strips untrusted diagnostics", () => {
  assert.deepEqual(parseHarnessInventory({ ...inventory, secrets: "no", items: [{ ...inventory.items[0], stderr: "token" }] }), inventory);
  for (const value of [null, {}, { ...inventory, schemaVersion: 2 }, { ...inventory, capturedAt: "bad" },
    { ...inventory, items: Array(65).fill(inventory.items[0]) },
    { ...inventory, items: [inventory.items[0], inventory.items[0]] },
    ...[{ path: "x".repeat(4097) }, { version: "x".repeat(129) }, { version: "1.2.3\nsecret" },
      { id: "../../run" }, { probeStatus: "invented" }, { installed: false }].map(patch => ({ ...inventory, items: [{ ...inventory.items[0], ...patch }] })),
  ]) assert.equal(parseHarnessInventory(value), undefined);
  assert.deepEqual(parseHarnessInventory({ ...inventory, items: [{ id: "codex", installed: false, probeStatus: "missing" }] }).items,
    [{ id: "codex", installed: false, probeStatus: "missing" }]);
});

test("every preset explicitly describes upstream management and unsupported platforms", () => {
  for (const preset of AGENT_PRESETS) {
    const management = preset.management;
    assert.ok(management, preset.id);
    assert.match(management.checkedAt, /^\d{4}-\d\d-\d\d$/u);
    assert.ok(Array.isArray(management.autoUpdate.controls));
    for (const kind of ["install", "update", "uninstall"]) {
      for (const platform of ["unix", "windows"]) {
        const command = management[kind][platform];
        assert.notEqual(command, undefined, `${preset.id}/${kind}/${platform}`);
        if (command) { assert.ok(command.command); assert.ok(command.args.every(arg => typeof arg === "string")); }
      }
    }
    if (management.version) {
      assert.ok(management.sources.length > 0, preset.id);
      assert.equal(new RegExp(management.version.regex, "u").exec("tool 1.2.3")[1], "1.2.3");
    } else assert.ok(management.notes, preset.id);
  }
  assert.equal(AGENT_PRESETS.find(p => p.id === "pi").management.version.command, "pi");
  assert.equal(AGENT_PRESETS.find(p => p.id === "vibe").management.version.command, "vibe");
  assert.ok(AGENT_PRESETS.find(p => p.id === "cursor").launcherNames.includes("agent"));
});

test("inventory items carry optional latest version and auto-update state", () => {
  const item = { ...inventory.items[0], latestVersion: "1.3.0", autoUpdate: "disabled" };
  assert.deepEqual(parseHarnessInventory({ ...inventory, items: [item] }).items[0], item);
  assert.equal(parseHarnessInventory({ ...inventory, items: [{ ...item, autoUpdate: "sometimes" }] }), undefined);
  assert.equal(parseHarnessInventory({ ...inventory, items: [{ ...item, latestVersion: "1\n2" }] }), undefined);
});

test("harness action requests name only a preset and an action", () => {
  const requestId = "harness:00000000-0000-4000-8000-000000000000";
  assert.deepEqual(parseHarnessActionRequest({ requestId, presetId: "claude", action: "update", command: "rm" }),
    { requestId, presetId: "claude", action: "update" });
  for (const patch of [{ action: "purge" }, { presetId: "../x" }, { requestId: "quota:1" }]) {
    assert.throws(() => parseHarnessActionRequest({ requestId, presetId: "claude", action: "update", ...patch }));
  }
});

test("harness action results must answer the issued request and stay bounded", () => {
  const issued = { requestId: "harness:00000000-0000-4000-8000-000000000000", presetId: "claude", action: "update" };
  const result = parseHarnessActionResult({ presetId: "claude", action: "update", status: "succeeded", exitCode: 0,
    outputTail: "ok\u001b[0m\n", item: { id: "claude", installed: true, version: "2.0.0", probeStatus: "ok" } }, issued);
  assert.equal(result.outputTail, "ok[0m\n");
  assert.equal(result.item.version, "2.0.0");
  for (const patch of [{ presetId: "codex" }, { action: "install" }, { status: "done" }, { outputTail: "x".repeat(4097) },
    { item: { id: "codex", installed: false, probeStatus: "missing" } },
    { inventory: { schemaVersion: 1, capturedAt: "2026-09-30T12:00:00Z", items: [] } }]) {
    assert.throws(() => parseHarnessActionResult({ presetId: "claude", action: "update", status: "failed", ...patch }, issued));
  }
  assert.equal(harnessOutputTail("a".repeat(5000)).length, 4096);
});

test("registry sources name official packages only where a preset publishes one", () => {
  for (const preset of AGENT_PRESETS) {
    const latest = preset.management?.latest;
    if (latest) assert.ok(["npm", "pypi"].includes(latest.kind) && latest.package, preset.id);
  }
  assert.equal(AGENT_PRESETS.find(p => p.id === "goose").management.latest, undefined);
});

test("an action is available only where an official recipe or control exists", () => {
  const preset = id => AGENT_PRESETS.find(p => p.id === id).management;
  assert.equal(harnessActionAvailable(preset("custom"), "install"), false);
  assert.equal(harnessActionAvailable(preset("custom"), "refresh"), true);
  assert.equal(harnessActionAvailable(undefined, "refresh"), false);
  assert.equal(harnessActionAvailable(preset("claude"), "update"), true);
  assert.equal(harnessActionAvailable(preset("claude"), "auto_update_off"), true);
  // goose has no updater of its own; xMatrix schedules its official update.
  assert.equal(harnessActionAvailable(preset("goose"), "auto_update_on"), true);
  assert.equal(harnessActionAvailable(preset("zcode"), "update"), false);
  assert.equal(harnessActionAvailable(preset("codex"), "uninstall"), true);
  // No verified uninstaller upstream: the action is never offered.
  assert.equal(harnessActionAvailable(preset("grok"), "uninstall"), false);
});

test("uninstall removes only the program, never settings or sessions", () => {
  for (const preset of AGENT_PRESETS) {
    for (const command of Object.values(preset.management.uninstall).filter(Boolean)) {
      const argv = [command.command, ...command.args].join(" ");
      assert.doesNotMatch(argv, /\.claude\b(?!\.)|\.claude\.json|--all\b/u, preset.id);
      if (command.command === "opencode") assert.ok(command.args.includes("--keep-config") && command.args.includes("--keep-data"));
    }
  }
});

test("a remote sign-in carries a pasted code only on login_finish and answers with an https link", () => {
  const requestId = "harness:00000000-0000-4000-8000-000000000000";
  assert.deepEqual(parseHarnessActionRequest({ requestId, presetId: "claude", action: "login_finish", code: "abc#def" }),
    { requestId, presetId: "claude", action: "login_finish", code: "abc#def" });
  for (const patch of [{ action: "login_start", code: "abc" }, { action: "update", code: "abc" },
    { action: "login_finish", code: "" }, { action: "login_finish", code: "a\nb" },
    { action: "login_finish", code: "x".repeat(2049) }]) {
    assert.throws(() => parseHarnessActionRequest({ requestId, presetId: "claude", ...patch }), JSON.stringify(patch));
  }
  const issued = { requestId, presetId: "codex", action: "login_start" };
  const waiting = { state: "awaiting_user", flow: "device_code", verificationUri: "https://auth.openai.com/codex/device",
    userCode: "I3YY-8QZ91" };
  assert.deepEqual(parseHarnessActionResult({ presetId: "codex", action: "login_start", status: "succeeded", login: waiting },
    issued).login, waiting);
  for (const login of [{ ...waiting, verificationUri: "http://auth.openai.com/" },
    { ...waiting, verificationUri: "javascript:alert(1)" }, { state: "awaiting_user" },
    { ...waiting, userCode: "x".repeat(65) }, { ...waiting, state: "signed_in" }, { state: "invented" }]) {
    assert.throws(() => parseHarnessActionResult({ presetId: "codex", action: "login_start", status: "succeeded", login },
      issued), JSON.stringify(login));
  }
  // Progress belongs to sign-in actions only.
  assert.throws(() => parseHarnessActionResult({ presetId: "codex", action: "update", status: "succeeded",
    login: { state: "signed_in" } }, { requestId, presetId: "codex", action: "update" }));
  assert.equal(parseHarnessInventory({ ...inventory, items: [{ ...inventory.items[0], login: "signed_in" }] }).items[0].login,
    "signed_in");
  assert.equal(parseHarnessInventory({ ...inventory, items: [{ ...inventory.items[0], login: "yes" }] }), undefined);
});

test("sign-in is offered exactly for presets with an official headless sign-in", () => {
  const signIn = AGENT_PRESETS.filter(preset => harnessActionAvailable(preset.management, "login_start")).map(preset => preset.id);
  assert.deepEqual(signIn.sort(), ["claude", "codex", "copilot", "cursor", "grok", "hermes", "kimi", "kiro", "opencode",
    "zcode"]);
  for (const preset of AGENT_PRESETS) {
    const login = preset.management.login;
    if (!login) continue;
    assert.ok(["device_code", "url_paste_code"].includes(login.flow), preset.id);
    assert.ok(preset.launcherNames.includes(login.start.command) || login.start.command === preset.runtime, preset.id);
    for (const pattern of [login.urlRegex, login.codeRegex, login.rejectedRegex, login.status?.signedInRegex]) {
      if (pattern) assert.doesNotThrow(() => new RegExp(pattern.replace(/^\(\?[a-z]+\)/u, "")), `${preset.id}: ${pattern}`);
    }
  }
});

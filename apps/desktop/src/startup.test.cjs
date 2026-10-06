const { readDesktopSource } = require("./desktop.test-fixture.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Exercise the actual startup callback and bridge wrapper without starting a
// real daemon, reading credentials, or changing the installed application's data.
const source = readDesktopSource("main.ts");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const startup = parsed.statements.find(node => node.getText(parsed).startsWith("app.whenReady().then("));
const bridge = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "secureIpc");
const javascript = ts.transpileModule(`${bridge.getText(parsed)}\n${startup.getText(parsed)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  let resolveProfile;
  let rejectProfile;
  const profile = new Promise((resolve, reject) => { resolveProfile = resolve; rejectProfile = reject; });
  const calls = [];
  let completion;
  const context = vm.createContext({
    desktopProfileReady: Promise.resolve(),
    appIsQuitting: false,
    // A synchronous whenReady() double, so the test holds startup's own promise.
    // oxlint-disable-next-line unicorn/no-thenable
    app: { whenReady: () => ({ then: callback => { completion = callback(); } }), on() {} },
    applyDesktopNativeTheme() {},
    loadDesktopProfileSelection: () => { calls.push("profile-start"); return profile; },
    registerIpcHandlers: () => calls.push("bridge-registered"),
    createWindow: () => calls.push("window-load"),
    startProfileRegistryWatcher: () => calls.push("watcher"),
    buildMenu() {},
    startDaemonBestEffort: async () => calls.push("daemon"),
    configureAutoUpdates() {},
    powerMonitor: { on() {} },
    dropStaleRendererConnections() {},
    isTrustedSender: event => event.trusted,
  });
  vm.runInContext(javascript, context);
  return { context, calls, completion, resolveProfile, rejectProfile };
}

test("window navigation overlaps profile loading; services and bridge wait for the profile", async () => {
  const h = harness();
  assert.deepEqual(h.calls, ["profile-start", "bridge-registered", "window-load"]);
  let invoked = false;
  const request = h.context.secureIpc((_event, value) => { invoked = true; return value; })({ trusted: true }, 42);
  await Promise.resolve();
  assert.equal(invoked, false);
  h.resolveProfile();
  await h.completion;
  assert.equal(await request, 42);
  assert.deepEqual(h.calls.slice(3), ["watcher", "daemon"]);
});

test("bridge rejects untrusted callers before waiting and rechecks after navigation", async () => {
  const h = harness();
  let calls = 0;
  const handler = h.context.secureIpc(() => calls++);
  await assert.rejects(handler({ trusted: false }), /Untrusted/);
  const event = { trusted: true };
  const pending = handler(event);
  event.trusted = false;
  h.resolveProfile();
  await assert.rejects(pending, /Untrusted/);
  await h.completion;
  assert.equal(calls, 0);
});

test("failed profile initialization never admits bridge work or starts services", async () => {
  const h = harness();
  const request = h.context.secureIpc(() => assert.fail("must not run"))({ trusted: true });
  const checks = [assert.rejects(request, /profile failure/), assert.rejects(h.completion, /profile failure/)];
  h.rejectProfile(new Error("profile failure"));
  await Promise.all(checks);
  assert.equal(h.calls.includes("daemon"), false);
});

test("quitting while the profile loads does not start background services", async () => {
  const h = harness();
  h.context.appIsQuitting = true;
  h.resolveProfile();
  await h.completion;
  assert.deepEqual(h.calls, ["profile-start", "bridge-registered", "window-load"]);
});

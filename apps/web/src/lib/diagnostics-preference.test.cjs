const assert = require("node:assert/strict");
const test = require("node:test");

require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  LEGACY_DIAGNOSTICS_STORAGE_KEY,
  chooseDiagnostics,
  configureDiagnosticsConsent,
  currentDiagnosticsDecision,
  diagnosticsMaySendNow,
  diagnosticsPromptDismissed,
  dismissDiagnosticsPrompt,
  refreshDiagnosticsConsent,
} = require("./diagnostics-preference.ts");

const MINUTE = 60_000;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/**
 * A fake Hub: what `GET /api/me/diagnostics` answers now (or throws), and the
 * choices `PUT` recorded. `clock` is the page's time.
 */
function hub({ accountRegime = "default-ok", requestRegime = "default-ok", choice = null, build = "beta",
  doNotTrack = null, globalPrivacyControl = false, storage = memoryStorage() } = {}) {
  const state = { accountRegime, requestRegime, choice, reads: 0, writes: [], fail: false, now: 1_000_000 };
  configureDiagnosticsConsent({
    async read(readBuild) {
      state.reads += 1;
      assert.equal(readBuild, build);
      if (state.fail) throw new Error("network down");
      return { accountRegime: state.accountRegime, requestRegime: state.requestRegime, choice: state.choice };
    },
    async write(next) {
      state.writes.push(next);
      state.choice = next;
    },
  }, { build, environment: { now: () => state.now, storage, doNotTrack, globalPrivacyControl } });
  return state;
}

test.afterEach(() => configureDiagnosticsConsent(null, { environment: null }));

test("beta: on by default with a notice only where both the signup and the current country are default-ok", async () => {
  hub();
  assert.equal(await diagnosticsMaySendNow(), true);
  assert.deepEqual(currentDiagnosticsDecision(), { send: true, prompt: "notice" });

  for (const regimes of [
    { accountRegime: "consent-required", requestRegime: "default-ok" },
    { accountRegime: "default-ok", requestRegime: "consent-required" },
    { accountRegime: "consent-required", requestRegime: "consent-required" },
  ]) {
    hub(regimes);
    assert.equal(await diagnosticsMaySendNow(), false, JSON.stringify(regimes));
    assert.deepEqual(currentDiagnosticsDecision(), { send: false, prompt: "opt-in" });
  }
});

test("stable: nothing is sent or prompted without an explicit opt-in, anywhere", async () => {
  hub({ build: "stable" });
  assert.equal(await diagnosticsMaySendNow(), false);
  assert.deepEqual(currentDiagnosticsDecision(), { send: false, prompt: "none" });
  hub({ build: "stable", accountRegime: "consent-required", requestRegime: "consent-required", choice: "opted-in" });
  assert.equal(await diagnosticsMaySendNow(), true);
});

test("Do Not Track and Global Privacy Control turn the default off; an explicit opt-in still sends", async () => {
  hub({ doNotTrack: "1" });
  assert.equal(await diagnosticsMaySendNow(), false);
  hub({ globalPrivacyControl: true });
  assert.equal(await diagnosticsMaySendNow(), false);
  assert.equal(currentDiagnosticsDecision().prompt, "none");
  hub({ globalPrivacyControl: true, choice: "opted-in" });
  assert.equal(await diagnosticsMaySendNow(), true);
});

test("ticking the opt-in box is consent; dismissing a prompt records nothing", async () => {
  const storage = memoryStorage();
  const state = hub({ requestRegime: "consent-required", storage });
  assert.equal(await diagnosticsMaySendNow(), false);
  dismissDiagnosticsPrompt("opt-in");
  assert.equal(diagnosticsPromptDismissed("opt-in"), true);
  assert.deepEqual(state.writes, [], "a dismissed prompt is not a choice");
  assert.equal(await diagnosticsMaySendNow(), false);

  await chooseDiagnostics("opted-in");
  assert.deepEqual(state.writes, ["opted-in"]);
  assert.equal(await diagnosticsMaySendNow(), true);

  const notice = hub({ storage: memoryStorage() });
  assert.equal(await diagnosticsMaySendNow(), true);
  dismissDiagnosticsPrompt("notice");
  assert.deepEqual(notice.writes, [], "dismissing the notice is not consent either");
});

test("the off switch stops sending at once, before the Hub answers", async () => {
  const state = hub();
  assert.equal(await diagnosticsMaySendNow(), true);
  let release;
  const written = new Promise((resolve) => { release = resolve; });
  const realWrite = state.writes;
  configureDiagnosticsConsent({
    read: async () => ({ accountRegime: "default-ok", requestRegime: "default-ok", choice: state.choice }),
    write: async (choice) => { await written; realWrite.push(choice); state.choice = choice; },
  }, { environment: { now: () => state.now, storage: memoryStorage(), doNotTrack: null, globalPrivacyControl: false } });
  await refreshDiagnosticsConsent();
  assert.equal(currentDiagnosticsDecision().send, true);
  const choosing = chooseDiagnostics("opted-out");
  assert.equal(currentDiagnosticsDecision().send, false, "off before the write lands");
  release();
  await choosing;
  assert.equal(await diagnosticsMaySendNow(), false);
});

test("before each send a stale answer is read again; travelling into a consent country stops sending", async () => {
  const state = hub();
  assert.equal(await diagnosticsMaySendNow(), true);
  assert.equal(state.reads, 1);
  state.now += 5 * MINUTE;
  assert.equal(await diagnosticsMaySendNow(), true);
  assert.equal(state.reads, 1, "a fresh answer is reused");

  state.requestRegime = "consent-required";
  state.now += 6 * MINUTE;
  assert.equal(await diagnosticsMaySendNow(), false);
  assert.equal(state.reads, 2);
  assert.deepEqual(currentDiagnosticsDecision(), { send: false, prompt: "opt-in" });
});

test("a failed region lookup sends nothing this time, never falling back to the signup regime", async () => {
  const state = hub();
  assert.equal(await diagnosticsMaySendNow(), true);
  state.fail = true;
  state.now += 11 * MINUTE;
  assert.equal(await diagnosticsMaySendNow(), false);
  assert.deepEqual(currentDiagnosticsDecision(), { send: false, prompt: "none" });

  const optedIn = hub({ choice: "opted-in" });
  optedIn.fail = true;
  assert.equal(await diagnosticsMaySendNow(), false);
  optedIn.fail = false;
  assert.equal(await diagnosticsMaySendNow(), true, "the next send asks again");
});

test("an answer without a request regime is no answer", async () => {
  configureDiagnosticsConsent({
    read: async () => ({ accountRegime: "default-ok", choice: null }),
    write: async () => {},
  }, { build: "beta", environment: { now: () => 1, storage: memoryStorage(), doNotTrack: null, globalPrivacyControl: false } });
  assert.equal(await diagnosticsMaySendNow(), false);
});

test("signed out, nothing is sent", async () => {
  configureDiagnosticsConsent(null);
  assert.equal(await diagnosticsMaySendNow(), false);
});

test("a choice an older build kept in this browser moves to the Hub once and leaves the browser", async () => {
  const storage = memoryStorage({ [LEGACY_DIAGNOSTICS_STORAGE_KEY]: "true" });
  const state = hub({ requestRegime: "consent-required", storage });
  assert.equal(await diagnosticsMaySendNow(), true);
  assert.deepEqual(state.writes, ["opted-in"]);
  assert.equal(storage.map.has(LEGACY_DIAGNOSTICS_STORAGE_KEY), false);

  const kept = memoryStorage({ [LEGACY_DIAGNOSTICS_STORAGE_KEY]: "true" });
  const chosen = hub({ choice: "opted-out", storage: kept });
  assert.equal(await diagnosticsMaySendNow(), false, "the Hub's own choice wins over the browser's old one");
  assert.deepEqual(chosen.writes, []);
});

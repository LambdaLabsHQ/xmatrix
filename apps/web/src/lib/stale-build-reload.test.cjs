const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  STALE_BUILD_RELOAD_COOLDOWN_MS,
  STALE_BUILD_RELOAD_STORAGE_KEY,
  WEB_BUILD_CHECK_MIN_INTERVAL_MS,
  WEB_BUILD_HIDDEN_RELOAD_DELAY_MS,
  WEB_BUILD_POLL_INTERVAL_MS,
  canAutoReloadStaleBuild,
  startWebBuildMonitor,
  tryReloadStaleBuild,
} = require("./stale-build-reload.ts");

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    values,
  };
}

function fakeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    timeouts,
    intervals,
    setTimer(callback, ms) {
      const id = nextId++;
      timeouts.set(id, { callback, ms });
      return id;
    },
    clearTimer(id) {
      timeouts.delete(id);
    },
    setPeriodic(callback, ms) {
      const id = nextId++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearPeriodic(id) {
      intervals.delete(id);
    },
    fireAllTimeouts() {
      const pending = Array.from(timeouts.entries());
      for (const [id, entry] of pending) {
        timeouts.delete(id);
        entry.callback();
      }
    },
    fireAllIntervals() {
      const pending = Array.from(intervals.values());
      for (const entry of pending) {
        entry.callback();
      }
    },
  };
}

test("tryReloadStaleBuild reloads once per build within cooldown and recovers when build or time advances", () => {
  const storage = memoryStorage();
  let reloads = 0;
  const reload = () => { reloads += 1; };

  assert.equal(canAutoReloadStaleBuild({ buildId: "build-a", storage, now: 1_000 }), true);
  assert.equal(tryReloadStaleBuild({ buildId: "build-a", storage, now: 1_000, reload }), true);
  assert.equal(reloads, 1);

  // Immediate repeat on the same build must be refused so a broken deploy cannot reload-loop.
  assert.equal(canAutoReloadStaleBuild({ buildId: "build-a", storage, now: 1_000 + STALE_BUILD_RELOAD_COOLDOWN_MS - 1 }), false);
  assert.equal(tryReloadStaleBuild({ buildId: "build-a", storage, now: 1_000 + STALE_BUILD_RELOAD_COOLDOWN_MS - 1, reload }), false);
  assert.equal(reloads, 1);

  // A reload that landed on a newer build may immediately auto-reload again if yet another deploy ships.
  assert.equal(canAutoReloadStaleBuild({ buildId: "build-b", storage, now: 2_000 }), true);
  assert.equal(tryReloadStaleBuild({ buildId: "build-b", storage, now: 2_000, reload }), true);
  assert.equal(reloads, 2);

  // After the cooldown elapses, the same build may attempt reload again.
  assert.equal(tryReloadStaleBuild({ buildId: "build-b", storage, now: 2_000 + STALE_BUILD_RELOAD_COOLDOWN_MS, reload }), true);
  assert.equal(reloads, 3);
});

test("tryReloadStaleBuild fails closed when session storage is unavailable or throws", () => {
  let reloads = 0;
  const reload = () => { reloads += 1; };

  assert.equal(canAutoReloadStaleBuild({ buildId: "build-a", storage: null, now: 1_000 }), false);
  assert.equal(tryReloadStaleBuild({ buildId: "build-a", storage: null, now: 1_000, reload }), false);

  const throwingWrite = {
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
  };
  assert.equal(tryReloadStaleBuild({ buildId: "build-a", storage: throwingWrite, now: 1_000, reload }), false);
  assert.equal(reloads, 0);

  // Corrupted prior marker is ignored rather than permanently disabling auto-reload.
  const storage = memoryStorage();
  storage.setItem(STALE_BUILD_RELOAD_STORAGE_KEY, "{not-json");
  assert.equal(tryReloadStaleBuild({ buildId: "build-a", storage, now: 1_000, reload }), true);
  assert.equal(reloads, 1);
});

test("startWebBuildMonitor is a no-op when no build id is embedded", () => {
  const timers = fakeTimers();
  let subscribed = false;
  let fetched = 0;

  const stop = startWebBuildMonitor({
    currentBuildId: "",
    canReloadQuietly: () => true,
    fetchBuildId: async () => { fetched += 1; return "build-2"; },
    subscribeVisibility: () => { subscribed = true; return () => {}; },
    ...timers,
  });

  assert.equal(subscribed, false);
  assert.equal(timers.intervals.size, 0);
  assert.equal(fetched, 0);
  stop();
});

test("startWebBuildMonitor detects a newer build and silently reloads only after resting hidden while safe", async () => {
  const timers = fakeTimers();
  const storage = memoryStorage();
  let clock = 10_000;
  let hidden = false;
  let online = true;
  let safeToReload = true;
  let visibilityListener = null;
  const events = [];
  let serverBuild = "build-1";

  const stop = startWebBuildMonitor({
    currentBuildId: "build-1",
    canReloadQuietly: () => safeToReload,
    onBeforeReload: () => events.push("flush"),
    fetchBuildId: async () => {
      events.push(`fetch:${serverBuild}`);
      return serverBuild;
    },
    storage,
    reload: () => events.push("reload"),
    now: () => clock,
    isHidden: () => hidden,
    isOnline: () => online,
    subscribeVisibility: (listener) => {
      visibilityListener = listener;
      return () => { visibilityListener = null; };
    },
    ...timers,
  });

  assert.equal(timers.intervals.size, 1);
  assert.equal([...timers.intervals.values()][0].ms, WEB_BUILD_POLL_INTERVAL_MS);

  // Visibility check before min interval does not fetch.
  visibilityListener();
  assert.deepEqual(events, []);

  // After min interval, returning to visible checks /api/web-build.
  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  clock += WEB_BUILD_CHECK_MIN_INTERVAL_MS;
  visibilityListener();
  await flushMicrotasks();
  assert.deepEqual(events, ["fetch:build-1"]);
  assert.equal(timers.intervals.size, 1, "unchanged build keeps polling");

  // New deploy ships; next periodic poll detects it and stops further polling.
  serverBuild = "build-2";
  clock += WEB_BUILD_POLL_INTERVAL_MS;
  timers.fireAllIntervals();
  await flushMicrotasks();
  assert.deepEqual(events, ["fetch:build-1", "fetch:build-2"]);
  assert.equal(timers.intervals.size, 0, "once an update is detected, polling stops");

  // Brief tab switch cancels the hidden reload when the user comes back before the delay.
  hidden = true;
  visibilityListener();
  assert.equal(timers.timeouts.size, 1);
  assert.equal([...timers.timeouts.values()][0].ms, WEB_BUILD_HIDDEN_RELOAD_DELAY_MS);
  hidden = false;
  visibilityListener();
  assert.equal(timers.timeouts.size, 0);
  assert.deepEqual(events, ["fetch:build-1", "fetch:build-2"]);

  // Unsafe state (e.g. unsent attachment / in-flight send) skips the hidden reload.
  safeToReload = false;
  hidden = true;
  visibilityListener();
  timers.fireAllTimeouts();
  assert.deepEqual(events, ["fetch:build-1", "fetch:build-2"]);

  // Offline state also skips the hidden reload.
  safeToReload = true;
  online = false;
  visibilityListener();
  timers.fireAllTimeouts();
  assert.deepEqual(events, ["fetch:build-1", "fetch:build-2"]);

  // Once online, safe, and hidden past the delay, drafts flush first and reload fires once.
  online = true;
  visibilityListener();
  timers.fireAllTimeouts();
  assert.deepEqual(events, ["fetch:build-1", "fetch:build-2", "flush", "reload"]);

  stop();
  assert.equal(visibilityListener, null);
});

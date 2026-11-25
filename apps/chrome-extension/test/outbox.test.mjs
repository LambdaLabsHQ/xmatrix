import assert from "node:assert/strict";
import test from "node:test";

import { HubError } from "../src/hub-client.js";
import {
  DEFAULT_FALLBACK_DELAY_MS,
  OUTBOX_ALARM_NAME,
  OUTBOX_FAILURES_STORAGE_KEY,
  OUTBOX_STORAGE_KEY,
  createOutbox,
} from "../src/outbox.js";

function memoryStorage() {
  const data = new Map();
  return {
    async get(key) {
      return { [key]: data.has(key) ? structuredClone(data.get(key)) : undefined };
    },
    async set(patch) {
      for (const [k, v] of Object.entries(patch)) data.set(k, structuredClone(v));
    },
    async remove(key) {
      data.delete(key);
    },
    peek(key = OUTBOX_STORAGE_KEY) {
      return data.get(key);
    },
  };
}

function fakeAlarms() {
  const active = new Map();
  return {
    active,
    async create(name, info) {
      active.set(name, info);
    },
    async clear(name) {
      active.delete(name);
    },
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= current) {
          timers.delete(id);
          await timer.fn();
        }
      }
    },
    timerCount: () => timers.size,
  };
}

test("normal send acked before fallback delay never triggers background Hub calls and clears alarm", async () => {
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock = fakeClock();
  const delivered = [];
  const outbox = createOutbox({
    storage,
    alarms,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackDelayMs: 8_000,
    deliver: async (entry) => {
      delivered.push(entry);
    },
  });

  await outbox.register({
    clientMessageId: "cm-normal-1",
    userId: "u1",
    tabId: 12,
    source: "inline",
    channelCreate: {
      requestKey: "rk-normal-1",
      spaceId: "sp-1",
      name: "Article",
      mode: "open",
      memberName: "Daniel",
    },
    body: "Hello?",
  });
  assert.equal((await outbox.list()).length, 1);
  assert.equal(alarms.active.has(OUTBOX_ALARM_NAME), true);

  await outbox.ack("cm-normal-1");
  assert.equal((await outbox.list()).length, 0);
  assert.equal(alarms.active.has(OUTBOX_ALARM_NAME), false);

  await clock.advance(20_000);
  assert.equal(delivered.length, 0);
});

test("closing or navigating the tab immediately flushes pending initial and follow-up sends", async () => {
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock = fakeClock();
  const delivered = [];
  const outbox = createOutbox({
    storage,
    alarms,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackDelayMs: 8_000,
    deliver: async (entry) => {
      delivered.push(entry);
    },
  });

  // Initial ask registered on Enter in tab 5, then tab navigated 400ms later.
  await outbox.register({
    clientMessageId: "cm-nav-1",
    userId: "u1",
    tabId: 5,
    source: "inline",
    channelCreate: {
      requestKey: "rk-nav-1",
      spaceId: "sp-1",
      name: "Page A",
      mode: "open",
      memberName: "Daniel",
      metadata: { autoName: true, createdBy: "chrome-extension" },
    },
    body: "Question before navigating",
    metadata: { browserPage: { title: "Page A", href: "https://a.test" } },
  });
  // Side-panel send on the same tab should NOT be flushed by inline-only navigation.
  await outbox.register({
    clientMessageId: "cm-panel-1",
    userId: "u1",
    tabId: 5,
    source: "sidepanel",
    channelId: "ch-existing",
    spaceId: "sp-1",
    body: "Side panel message",
  });

  await clock.advance(400);
  await outbox.flushForTab(5, { source: "inline" });
  assert.deepEqual(delivered.map((item) => item.clientMessageId), ["cm-nav-1"]);
  assert.equal(delivered[0].channelCreate.requestKey, "rk-nav-1");
  assert.deepEqual((await outbox.list()).map((item) => item.clientMessageId), ["cm-panel-1"]);

  // Closing the tab flushes remaining sends (including side-panel sends bound to that tab).
  await outbox.flushForTab(5, { tabRemoved: true });
  assert.deepEqual(delivered.map((item) => item.clientMessageId), ["cm-nav-1", "cm-panel-1"]);
  assert.equal((await outbox.list()).length, 0);
});

test("register arriving milliseconds after tabs.onRemoved still flushes immediately", async () => {
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock = fakeClock();
  const delivered = [];
  const outbox = createOutbox({
    storage,
    alarms,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackDelayMs: 8_000,
    deliver: async (entry) => {
      delivered.push(entry);
    },
  });

  await outbox.flushForTab(77, { tabRemoved: true });
  await outbox.register({
    clientMessageId: "cm-race-1",
    userId: "u1",
    tabId: 77,
    source: "inline",
    channelId: "ch-77",
    body: "Follow-up right before close",
  });
  assert.deepEqual(delivered.map((item) => item.clientMessageId), ["cm-race-1"]);
  assert.equal((await outbox.list()).length, 0);
});

test("persisted entries survive service worker restart and recover() delivers them", async () => {
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock1 = fakeClock(1_700_000_000_000);

  const sw1 = createOutbox({
    storage,
    alarms,
    now: clock1.now,
    setTimer: clock1.setTimer,
    clearTimer: clock1.clearTimer,
    fallbackDelayMs: 8_000,
    deliver: async () => {
      throw new Error("sw1 should not deliver before hibernation");
    },
  });
  await sw1.register({
    clientMessageId: "cm-hibernated-1",
    userId: "u1",
    tabId: 9,
    source: "inline",
    channelCreate: {
      requestKey: "rk-hibernated-1",
      spaceId: "sp-1",
      name: "Sleepy Tab",
      mode: "open",
      memberName: "Daniel",
    },
    body: "Survives SW sleep",
  });
  assert.equal(storage.peek().length, 1);

  // Simulate SW hibernation (all in-memory timers lost) + wake 10 seconds later with a brand-new instance.
  const clock2 = fakeClock(1_700_000_010_000);
  const delivered = [];
  const sw2 = createOutbox({
    storage,
    alarms,
    now: clock2.now,
    setTimer: clock2.setTimer,
    clearTimer: clock2.clearTimer,
    fallbackDelayMs: 8_000,
    deliver: async (entry) => {
      delivered.push(entry);
    },
  });
  await sw2.recover();
  assert.deepEqual(delivered.map((item) => item.clientMessageId), ["cm-hibernated-1"]);
  assert.equal(storage.peek(), undefined);
});

test("transient delivery failure retries with backoff and remembers channelCreated progress", async () => {
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock = fakeClock();
  const calls = [];
  let attempt = 0;

  const outbox = createOutbox({
    storage,
    alarms,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackDelayMs: 8_000,
    deliver: async (entry, { onChannelCreated }) => {
      attempt += 1;
      calls.push({ attempt, channelCreated: entry.channelCreated === true, channelId: entry.channelId ?? null });
      if (attempt === 1) {
        await onChannelCreated({ channelId: "ch-created-1", spaceId: "sp-1" });
        throw new HubError(503, "Temporary outage", "unavailable", { retryable: true });
      }
    },
  });

  await outbox.register({
    clientMessageId: "cm-retry-1",
    userId: "u1",
    tabId: 10,
    source: "inline",
    channelCreate: {
      requestKey: "rk-retry-1",
      spaceId: "sp-1",
      name: "Flaky",
      mode: "open",
      memberName: "Daniel",
    },
    body: "Retry me",
  });

  await outbox.flushForTab(10, { tabRemoved: true });
  assert.equal(attempt, 1);
  const stored = await outbox.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].channelCreated, true);
  assert.equal(stored[0].channelId, "ch-created-1");
  assert.equal(stored[0].attempts, 1);

  // Backoff timer (3000ms) fires and succeeds without re-creating the channel.
  await clock.advance(3_000);
  assert.equal(attempt, 2);
  assert.deepEqual(calls, [
    { attempt: 1, channelCreated: false, channelId: null },
    { attempt: 2, channelCreated: true, channelId: "ch-created-1" },
  ]);
  assert.equal((await outbox.list()).length, 0);
});

test("permanent 4xx errors record a dismissible failure notice while silent drops and clearAll() do not leak", async () => {
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock = fakeClock();
  let calls = 0;

  const outbox = createOutbox({
    storage,
    alarms,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    fallbackDelayMs: 20_000,
    deliver: async (entry) => {
      calls += 1;
      if (entry.clientMessageId === "cm-mismatch-1") {
        throw new HubError(403, "Outbox entry belongs to another account.", "account_mismatch");
      }
      throw new HubError(403, "Forbidden", "forbidden");
    },
  });

  await outbox.register({
    clientMessageId: "cm-perm-1",
    userId: "u1",
    tabId: 11,
    source: "inline",
    channelId: "ch-11",
    title: "Secret Page",
    body: "> Quoted text\n\nWhy did this fail?",
  });
  await outbox.flushForTab(11, { tabRemoved: true });
  assert.equal(calls, 1);
  assert.equal((await outbox.list()).length, 0);
  const failures = await outbox.listFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].clientMessageId, "cm-perm-1");
  assert.equal(failures[0].preview, "Why did this fail?");

  // Dismissing clears persisted failures.
  await outbox.clearFailures();
  assert.equal((await outbox.listFailures()).length, 0);
  assert.equal(storage.peek(OUTBOX_FAILURES_STORAGE_KEY), undefined);

  // Account mismatch drops silently without showing a failure notice to the new account.
  await outbox.register({
    clientMessageId: "cm-mismatch-1",
    userId: "u1",
    tabId: 12,
    source: "inline",
    channelId: "ch-12",
    body: "Other user's send",
  });
  await outbox.flushForTab(12, { tabRemoved: true });
  assert.equal((await outbox.listFailures()).length, 0);

  // Sign-out clearAll wipes pending entries and failure notices alike.
  await outbox.register({
    clientMessageId: "cm-signout-1",
    userId: "u1",
    tabId: 13,
    source: "inline",
    channelId: "ch-13",
    body: "Cleared on sign out",
  });
  await outbox.clearAll();
  assert.equal((await outbox.list()).length, 0);
  assert.equal(alarms.active.has(OUTBOX_ALARM_NAME), false);
});

test("default fallback waits 20s to avoid racing slow live sends, and records failure after exhausting retries", async () => {
  assert.equal(DEFAULT_FALLBACK_DELAY_MS, 20_000);
  const storage = memoryStorage();
  const alarms = fakeAlarms();
  const clock = fakeClock();
  let calls = 0;

  const outbox = createOutbox({
    storage,
    alarms,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    maxAttempts: 2,
    deliver: async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    },
  });

  await outbox.register({
    clientMessageId: "cm-exhaust-1",
    userId: "u1",
    tabId: 20,
    source: "inline",
    channelId: "ch-20",
    body: "Offline question",
  });

  // At 8s (when a slow live send is still finishing), background stays quiet.
  await clock.advance(8_000);
  assert.equal(calls, 0);

  // At 20s total, fallback fires attempt 1, then retries after 3s backoff for attempt 2 and gives up with a notice.
  await clock.advance(12_000);
  assert.equal(calls, 1);
  assert.equal((await outbox.listFailures()).length, 0);

  await clock.advance(3_000);
  assert.equal(calls, 2);
  assert.equal((await outbox.list()).length, 0);
  const failures = await outbox.listFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].clientMessageId, "cm-exhaust-1");
  assert.equal(failures[0].preview, "Offline question");
});

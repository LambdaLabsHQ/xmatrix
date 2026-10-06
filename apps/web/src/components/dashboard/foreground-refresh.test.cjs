const assert = require("node:assert/strict");
const { test } = require("node:test");

test("foreground refresh coalesces resume signals, skips hidden/offline pages, and cleans up", async (t) => {
  const { listenForForegroundRefresh } = await import("./foreground-refresh.ts");
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: true });
  let now = 0;
  for (const [key, value] of Object.entries({ window: win, document: doc, navigator: { onLine: true } })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    });
  }
  t.mock.method(performance, "now", () => now);
  let count = 0;
  const stop = listenForForegroundRefresh(() => count++);
  win.dispatchEvent(new Event("focus"));
  assert.equal(count, 0);
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("focus"));
  win.dispatchEvent(new Event("pageshow"));
  assert.equal(count, 1);
  now += 1_000;
  navigator.onLine = false;
  win.dispatchEvent(new Event("focus"));
  assert.equal(count, 1);
  navigator.onLine = true;
  win.dispatchEvent(new Event("online"));
  assert.equal(count, 2);
  now += 1_000;
  win.dispatchEvent(new Event("pageshow"));
  assert.equal(count, 3);
  stop();
  now += 1_000;
  win.dispatchEvent(new Event("focus"));
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(count, 3);
});

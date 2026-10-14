const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readDashboardSource } = require("./source-scan-fixture.cjs");

const compiled = ts.transpileModule(
  readDashboardSource("timeline-reading-anchor.ts"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function timeline({ userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36" } = {}) {
  let now = 0;
  let nextTimerId = 0;
  let contentTop = 100;
  const timers = new Map();
  const listeners = new Map();
  const observers = [];
  const content = { getBoundingClientRect: () => ({ top: contentTop, bottom: contentTop + 100 }) };
  const row = { id: "message:reader", lastElementChild: content, children: [], hasAttribute: () => false };
  const root = {
    scrollTop: 0,
    children: [row],
    ownerDocument: { getElementById: (id) => id === row.id ? row : null },
    contains: (element) => element === row,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [row],
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.equal(name, "react");
      return {
        useCallback: (callback) => callback,
        useEffect: () => {},
        useMemo: (factory) => factory(),
        useRef: (current) => ({ current }),
      };
    },
    navigator: { userAgent },
    performance: { now: () => now },
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.connected = true; observers.push(this); }
      observe() {}
      disconnect() { this.connected = false; }
    },
  });
  const anchor = exports.useTimelineReadingAnchor(root);
  return {
    anchor,
    start() { const key = {}; anchor.snapshot(key); anchor.apply(key); },
    resize() { for (const observer of observers) if (observer.connected) observer.callback(); },
    scrollDrift() { contentTop += 1; listeners.get("scroll")?.(); },
    /** Someone else scrolls the timeline: the reader, or the virtualizer. */
    scrollBy(delta) { root.scrollTop += delta; contentTop -= delta; listeners.get("scroll")?.(); },
    /** A row above grows; the next resize puts the reader's row back. */
    growAbove(delta) { contentTop += delta; },
    advance(to) {
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= to)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = to;
    },
    active: () => observers.some((observer) => observer.connected) || listeners.size > 0,
    pendingTimers: () => timers.size,
  };
}

test("continuous scroll drift without another resize still releases at the deadline", () => {
  const view = timeline();
  view.start();
  view.resize();
  for (let time = 500; time < 10_000; time += 500) {
    view.advance(time);
    view.scrollDrift();
    assert.equal(view.active(), true);
  }
  view.advance(10_000);
  assert.equal(view.active(), false);
  assert.equal(view.pendingTimers(), 0);
});

test("quiet layout releases early and cancels its deadline", () => {
  const view = timeline();
  view.start();
  view.resize();
  view.advance(749);
  assert.equal(view.active(), true);
  view.advance(750);
  assert.equal(view.active(), false);
  assert.equal(view.pendingTimers(), 0);
});

test("explicit release and replacement cancel every previous timer", () => {
  const view = timeline();
  view.start();
  view.resize();
  view.advance(500);
  view.start();
  view.resize();
  assert.equal(view.pendingTimers(), 2);
  view.anchor.release();
  assert.equal(view.active(), false);
  assert.equal(view.pendingTimers(), 0);
  view.advance(20_000);
  assert.equal(view.active(), false);
});

test("on iOS a scroll that is not the anchor's own releases it, so nothing is written mid-momentum", () => {
  const view = timeline({ userAgent: IPHONE });
  view.start();
  view.growAbove(40);
  view.resize();
  // The anchor's correction raises its own scroll event: still holding.
  view.scrollDrift();
  assert.equal(view.active(), true);
  view.scrollBy(-80);
  assert.equal(view.active(), false);
  assert.equal(view.pendingTimers(), 0);
});

test("elsewhere the anchor follows the reader's scroll and keeps holding", () => {
  const view = timeline();
  view.start();
  view.resize();
  view.scrollBy(-80);
  assert.equal(view.active(), true);
});

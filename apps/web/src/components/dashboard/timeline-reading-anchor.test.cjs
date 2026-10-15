const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readDashboardSource } = require("./source-scan-fixture.cjs");

const compile = (name) => ts.transpileModule(
  readDashboardSource(name),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const compiled = compile("timeline-reading-anchor.ts");
const scrollRestCompiled = compile("timeline-scroll-rest.ts");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";

/** A clock whose timers run only when it is advanced. */
function testClock() {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
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
    pending: () => timers.size,
  };
}

/** A scroll root that remembers one listener per event, like the timeline's. */
function listenedRoot(fields) {
  const listeners = new Map();
  return {
    listeners,
    emit: (name, event = {}) => listeners.get(name)?.(event),
    root: {
      ...fields,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => {
        if (listeners.get(name) === callback) listeners.delete(name);
      },
    },
  };
}

function loadScrollRest(userAgent) {
  const exports = {};
  const clock = testClock();
  vm.runInNewContext(scrollRestCompiled, {
    exports,
    navigator: { userAgent },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { exports, clock };
}

function timeline({ userAgent = DESKTOP } = {}) {
  const clock = testClock();
  let contentTop = 100;
  const observers = [];
  const content = { getBoundingClientRect: () => ({ top: contentTop, bottom: contentTop + 100 }) };
  const row = { id: "message:reader", lastElementChild: content, children: [], hasAttribute: () => false };
  const { root, listeners } = listenedRoot({
    scrollTop: 0,
    children: [row],
    ownerDocument: { getElementById: (id) => id === row.id ? row : null },
    contains: (element) => element === row,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [row],
  });
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      if (name === "./timeline-scroll-rest") return loadScrollRest(userAgent).exports;
      assert.equal(name, "react");
      return {
        useCallback: (callback) => callback,
        useEffect: () => {},
        useMemo: (factory) => factory(),
        useRef: (current) => ({ current }),
      };
    },
    navigator: { userAgent },
    performance: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
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
    advance: clock.advance,
    active: () => observers.some((observer) => observer.connected) || listeners.size > 0,
    pendingTimers: clock.pending,
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

/* An older page waits for the timeline to rest (timeline-scroll-rest). */

async function settled(promise) {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

function restingTimeline() {
  const { exports, clock } = loadScrollRest(IPHONE);
  const { root, listeners, emit } = listenedRoot({});
  return { rest: exports.timelineScrollRest(root), clock, listeners, emit };
}

test("only iPhone WebKit holds an older page for the timeline to rest", () => {
  assert.equal(loadScrollRest(IPHONE).exports.SCROLLING_MOVES_NO_ROWS, true);
  assert.equal(loadScrollRest(DESKTOP).exports.SCROLLING_MOVES_NO_ROWS, false);
});

test("a timeline already at rest is at rest after one quiet interval", async () => {
  const view = restingTimeline();
  view.clock.advance(149);
  assert.equal(await settled(view.rest), false);
  view.clock.advance(150);
  assert.equal(await settled(view.rest), true);
  assert.equal(view.listeners.size, 0);
});

test("a flick still carrying the timeline holds the page until it stops", async () => {
  const view = restingTimeline();
  for (let at = 16; at <= 1_600; at += 16) {
    view.clock.advance(at);
    view.emit("scroll");
  }
  assert.equal(await settled(view.rest), false);
  view.clock.advance(1_600 + 150);
  assert.equal(await settled(view.rest), true);
});

test("a finger on the timeline holds the page until it lifts and the scroll stops", async () => {
  const view = restingTimeline();
  view.emit("touchstart");
  view.clock.advance(2_000);
  assert.equal(await settled(view.rest), false);
  view.emit("touchend", { touches: [] });
  view.clock.advance(2_100);
  view.emit("scroll");
  view.clock.advance(2_249);
  assert.equal(await settled(view.rest), false);
  view.clock.advance(2_250);
  assert.equal(await settled(view.rest), true);
});

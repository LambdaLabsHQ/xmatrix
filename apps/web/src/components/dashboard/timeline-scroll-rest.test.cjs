const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { readDashboardSource } = require("./source-scan-fixture.cjs");

const compiled = ts.transpileModule(
  readDashboardSource("timeline-scroll-rest.ts"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";

function load(userAgent = IPHONE) {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const root = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    navigator: { userAgent },
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    exports,
    root,
    listeners,
    emit(name, event = {}) { listeners.get(name)?.(event); },
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
  };
}

async function settled(promise) {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

test("only iPhone WebKit holds an older page for the timeline to rest", () => {
  assert.equal(load(IPHONE).exports.SCROLLING_MOVES_NO_ROWS, true);
  assert.equal(load(DESKTOP).exports.SCROLLING_MOVES_NO_ROWS, false);
});

test("a timeline already at rest is at rest after one quiet interval", async () => {
  const page = load();
  const rest = page.exports.timelineScrollRest(page.root);
  page.advance(149);
  assert.equal(await settled(rest), false);
  page.advance(150);
  assert.equal(await settled(rest), true);
  assert.equal(page.listeners.size, 0);
});

test("a flick still carrying the timeline holds the page until it stops", async () => {
  const page = load();
  const rest = page.exports.timelineScrollRest(page.root);
  for (let at = 16; at <= 1_600; at += 16) {
    page.advance(at);
    page.emit("scroll");
  }
  assert.equal(await settled(rest), false);
  page.advance(1_600 + 150);
  assert.equal(await settled(rest), true);
});

test("a finger on the timeline holds the page until it lifts and the scroll stops", async () => {
  const page = load();
  const rest = page.exports.timelineScrollRest(page.root);
  page.emit("touchstart");
  page.advance(2_000);
  assert.equal(await settled(rest), false);
  page.emit("touchend", { touches: [] });
  page.advance(2_100);
  page.emit("scroll");
  page.advance(2_249);
  assert.equal(await settled(rest), false);
  page.advance(2_250);
  assert.equal(await settled(rest), true);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/selection.js");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

/** Runs the real content script in a lightweight DOM harness to test its placement contract. */
function mountSelectionScript({ width = 1280, height = 800 } = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const runtimeListeners = [];
  const postedToFrame = [];
  let createdFrame = null;
  let selection = { text: "", rect: null, isCollapsed: true };

  const addListener = (map) => (type, handler) => {
    const list = map.get(type) ?? [];
    list.push(handler);
    map.set(type, list);
  };
  const removeListener = (map) => (type, handler) => {
    const list = map.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  };
  const dispatch = (map, type, event = {}) => {
    for (const handler of map.get(type) ?? []) handler(event);
  };

  const sandbox = {
    innerWidth: width,
    innerHeight: height,
    location: { href: "https://example.test/article" },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    Date,
    URL,
    Number,
    Math,
    String,
    Boolean,
    chrome: {
      runtime: {
        getURL: (relative) => `https://ext-id.invalid/${relative}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn),
          removeListener: (fn) => {
            const index = runtimeListeners.indexOf(fn);
            if (index >= 0) runtimeListeners.splice(index, 1);
          },
        },
      },
    },
    getSelection: () => ({
      isCollapsed: selection.isCollapsed,
      rangeCount: selection.rect ? 1 : 0,
      toString: () => selection.text,
      getRangeAt: () => ({ getBoundingClientRect: () => selection.rect }),
    }),
    document: {
      title: "Example Article",
      activeElement: {},
      documentElement: {
        append(node) {
          createdFrame = node;
        },
      },
      querySelectorAll: () => [],
      createElement(tag) {
        assert.equal(tag, "iframe");
        const contentWindow = {
          postMessage(data, targetOrigin) {
            postedToFrame.push({ data, targetOrigin });
          },
        };
        return {
          src: "",
          title: "",
          allow: "",
          style: {},
          contentWindow,
          blur() {},
          remove() { createdFrame = null; },
        };
      },
      addEventListener: addListener(documentListeners),
      removeEventListener: removeListener(documentListeners),
    },
    addEventListener: addListener(windowListeners),
    removeEventListener: removeListener(windowListeners),
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(scriptSource, sandbox, { filename: scriptPath });

  const sendFromFrame = (data) => {
    dispatch(windowListeners, "message", {
      source: createdFrame.contentWindow,
      origin: "https://ext-id.invalid",
      data: { xmatrixAsk: true, ...data },
    });
  };

  return {
    async select(text, rect) {
      selection = { text, rect, isCollapsed: false };
      dispatch(documentListeners, "mouseup", { target: {} });
      await Promise.resolve();
      await Promise.resolve();
    },
    openFromContextMenu(message) {
      for (const listener of runtimeListeners) listener(message);
    },
    ready() {
      sendFromFrame({ type: "ready" });
    },
    reportSize(size) {
      sendFromFrame({ type: "size", ...size });
    },
    resizeViewport(nextWidth, nextHeight) {
      sandbox.innerWidth = nextWidth;
      sandbox.innerHeight = nextHeight;
      dispatch(windowListeners, "resize", {});
    },
    frame: () => createdFrame,
    lastPosted: () => postedToFrame.at(-1)?.data,
    posted: () => postedToFrame.map((entry) => entry.data),
  };
}

test("opens below the selection with downward completion and keeps the input top pinned as the list expands", async () => {
  const harness = mountSelectionScript({ width: 1280, height: 800 });
  await harness.select("selected sentence", { top: 120, bottom: 144, left: 200, width: 180, height: 24 });
  harness.ready();

  const prepared = harness.lastPosted();
  assert.equal(prepared.xmatrixAsk, "prepared");
  assert.equal(prepared.placement, "below");
  assert.ok(prepared.maxPanelHeight >= 400, "below has plenty of viewport room");

  // Collapsed composer: 52px tall capsule inside 24px top inset + 44px bottom inset.
  harness.reportSize({ width: 520, height: 120, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  const collapsedTop = parseFloat(harness.frame().style.top);
  assert.equal(collapsedTop + 24, 152, "visible capsule top sits 8px below anchor.bottom (144)");
  assert.equal(parseFloat(harness.frame().style.left) + 32, 200, "visible capsule left aligns with selection left");

  // Completion opens downward: capsule grows by 240px; visible top stays pixel-locked.
  harness.reportSize({ width: 520, height: 360, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  assert.equal(parseFloat(harness.frame().style.top), collapsedTop, "input row does not jump when dropdown opens");
  assert.equal(harness.frame().style.height, "360px");
});

test("flips above the selection near the viewport bottom and keeps the input bottom pinned as the list grows upward", async () => {
  const harness = mountSelectionScript({ width: 1280, height: 800 });
  // Only 76px below the selection, plenty of room above.
  await harness.select("bottom passage", { top: 680, bottom: 708, left: 240, width: 160, height: 28 });
  harness.ready();

  const prepared = harness.lastPosted();
  assert.equal(prepared.xmatrixAsk, "prepared");
  assert.equal(prepared.placement, "above");
  assert.ok(prepared.maxPanelHeight >= 500, "above gets the room above the selection");

  // Collapsed composer above the selection: visible capsule bottom sits 8px above anchor.top (680 -> 672).
  harness.reportSize({ width: 520, height: 120, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  const collapsedTop = parseFloat(harness.frame().style.top);
  assert.equal(collapsedTop + 120 - 44, 672, "visible capsule bottom sits 8px above anchor.top");

  // Completion opens upward: capsule grows by 240px; frame top shifts up 240px so visible bottom stays at 672.
  harness.reportSize({ width: 520, height: 360, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  const expandedTop = parseFloat(harness.frame().style.top);
  assert.equal(expandedTop, collapsedTop - 240);
  assert.equal(expandedTop + 360 - 44, 672, "input row stays anchored above selection without covering it");
});

test("re-adapts placement when the window resizes while the ask box is open", async () => {
  const harness = mountSelectionScript({ width: 1280, height: 900 });
  await harness.select("mid page text", { top: 460, bottom: 484, left: 100, width: 140, height: 24 });
  harness.ready();
  assert.equal(harness.lastPosted().placement, "below");
  harness.reportSize({ width: 520, height: 120, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });

  // Shrinking the window leaves little room below (140px) vs plenty above (444px): flips to above.
  harness.resizeViewport(1280, 640);
  const updated = harness.lastPosted();
  assert.equal(updated.xmatrixAsk, "layout");
  assert.equal(updated.placement, "above");
  assert.equal(parseFloat(harness.frame().style.top) + 120 - 44, 452, "repositions 8px above anchor.top");
});

test("context-menu Ask about this page opens below near the top-right corner", () => {
  const harness = mountSelectionScript({ width: 1280, height: 800 });
  harness.openFromContextMenu({ type: "open-ask", page: true, text: "Example Article" });
  harness.ready();

  assert.equal(harness.lastPosted().placement, "below");
  harness.reportSize({ width: 520, height: 120, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  assert.equal(parseFloat(harness.frame().style.top) + 24, 24);
  assert.equal(parseFloat(harness.frame().style.left) + 520 - 32, 1272, "visible capsule hugs right edge with 8px margin");
});

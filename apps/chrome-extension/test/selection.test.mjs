import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/selection.js");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

/** Runs the real content script in a lightweight DOM harness to test its placement contract. */
function mountSelectionScript({ width = 1280, height = 800, initialPageState = null, prepareState = null } = {}) {
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
    Promise,
    chrome: {
      runtime: {
        getURL: (relative) => `https://ext-id.invalid/${relative}`,
        sendMessage: async (msg) => {
          if (msg?.type === "askPageState" && initialPageState) return { ok: true, value: initialPageState };
          if (msg?.type === "askPrepare" && prepareState) {
            const value = typeof prepareState === "function" ? prepareState(msg) : prepareState;
            return { ok: true, value };
          }
          return { ok: true };
        },
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

  const selectWith = async (text, rect, trigger) => {
    selection = { text, rect, isCollapsed: false };
    dispatch(documentListeners, "selectionchange", {});
    trigger();
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    select(text, rect) {
      return selectWith(text, rect, () => dispatch(windowListeners, "mouseup", { target: {} }));
    },
    dragSelect(text, rect) {
      dispatch(documentListeners, "mousedown", { target: {} });
      return selectWith(text, rect, () => dispatch(windowListeners, "mouseup", { target: {} }));
    },
    keyboardSelect(text, rect) {
      return selectWith(text, rect, () => dispatch(documentListeners, "keyup", { key: "ArrowRight", shiftKey: true }));
    },
    pressEscape() {
      dispatch(documentListeners, "keyup", { key: "Escape", shiftKey: false });
    },
    setVisibility(hidden) {
      sandbox.document.hidden = hidden;
      dispatch(documentListeners, "visibilitychange", {});
    },
    openFromContextMenu(message) {
      for (const listener of runtimeListeners) listener(message);
    },
    sendExtensionMessage(message) {
      for (const listener of runtimeListeners) listener(message);
    },
    ready() {
      sendFromFrame({ type: "ready" });
    },
    reportSize(size) {
      sendFromFrame({ type: "size", ...size });
    },
    sendFromFrame,
    scroll() {
      dispatch(documentListeners, "scroll", {});
    },
    clickOutside({ keepSelection = false } = {}) {
      dispatch(documentListeners, "mousedown", { target: {} });
      if (!keepSelection) {
        selection = { text: "", rect: null, isCollapsed: true };
        dispatch(documentListeners, "selectionchange", {});
      }
      dispatch(windowListeners, "mouseup", { target: {} });
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
  const collapsedHeight = parseFloat(harness.frame().style.height);
  assert.equal(collapsedTop + 24, 152, "visible capsule top sits 8px below anchor.bottom (144)");
  assert.equal(parseFloat(harness.frame().style.left) + 32, 200, "visible capsule left aligns with selection left");
  assert.equal(harness.frame().style.clipPath, `inset(0px 0px ${collapsedHeight - 120}px 0px)`);

  // Completion opens downward: two-tier clip-path opens ONCE to collapsedHeight + maxPanelHeight
  // and stays invariant while candidates grow/shrink/filter, then snaps back to hugging the capsule on close.
  harness.sendFromFrame({ type: "panel", open: true });
  const openClipPath = harness.frame().style.clipPath;
  assert.notEqual(openClipPath, `inset(0px 0px ${collapsedHeight - 120}px 0px)`, "panel open expands clip-path immediately");
  harness.reportSize({ width: 520, height: 360, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  assert.equal(parseFloat(harness.frame().style.top), collapsedTop, "input row does not jump when dropdown opens");
  assert.equal(parseFloat(harness.frame().style.height), collapsedHeight, "iframe height stays constant while typing");
  assert.equal(harness.frame().style.clipPath, openClipPath, "clip-path stays fixed while filtering/growing candidates");
  harness.reportSize({ width: 520, height: 220, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  assert.equal(harness.frame().style.clipPath, openClipPath, "clip-path stays fixed while backspacing/shrinking candidates");

  // Closing completion snaps clip-path tightly back to the resting capsule so webpage below is interactive.
  harness.sendFromFrame({ type: "panel", open: false });
  harness.reportSize({ width: 520, height: 120, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  assert.equal(parseFloat(harness.frame().style.top), collapsedTop, "top stays constant while typing");
  assert.equal(parseFloat(harness.frame().style.height), collapsedHeight, "height stays constant while typing");
  assert.equal(harness.frame().style.clipPath, `inset(0px 0px ${collapsedHeight - 120}px 0px)`, "unused runway stays clipped so page below is click/scroll-through");
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
  const collapsedHeight = parseFloat(harness.frame().style.height);
  assert.equal(collapsedTop + collapsedHeight - 44, 672, "visible capsule bottom sits 8px above anchor.top");
  assert.equal(harness.frame().style.clipPath, `inset(${collapsedHeight - 120}px 0px 0px 0px)`);

  // Completion opens upward: capsule grows by 240px; iframe top & height stay pixel-locked while clip-path opens upward.
  harness.reportSize({ width: 520, height: 360, topInset: 24, bottomInset: 44, leftInset: 32, rightInset: 32 });
  assert.equal(parseFloat(harness.frame().style.top), collapsedTop, "iframe top stays constant (no cross-origin frame jump)");
  assert.equal(parseFloat(harness.frame().style.height), collapsedHeight, "iframe height stays constant (no resize flash)");
  assert.equal(parseFloat(harness.frame().style.top) + parseFloat(harness.frame().style.height) - 44, 672, "input row stays anchored above selection without covering it");
  assert.equal(harness.frame().style.clipPath, `inset(${collapsedHeight - 360}px 0px 0px 0px)`);
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
  assert.equal(
    parseFloat(harness.frame().style.top) + parseFloat(harness.frame().style.height) - 44,
    452,
    "repositions 8px above anchor.top",
  );
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

test("inline thread stays open on page scroll and page clicks, and minimizes to right-edge dock on Escape or ×", async () => {
  const harness = mountSelectionScript({ width: 1280, height: 800 });
  await harness.select("selected sentence", { top: 120, bottom: 144, left: 200, width: 180, height: 24 });
  harness.ready();
  harness.reportSize({ width: 528, height: 100, topInset: 12, bottomInset: 36, leftInset: 24, rightInset: 24 });

  // Enter expands in place into thread mode.
  harness.sendFromFrame({ type: "mode", mode: "thread" });
  harness.reportSize({ width: 528, height: 360, topInset: 12, bottomInset: 36, leftInset: 24, rightInset: 24 });
  assert.equal(harness.frame().style.visibility, "visible");

  // D1: Scrolling or clicking the page does NOT close an active inline thread.
  harness.scroll();
  harness.clickOutside();
  assert.equal(harness.frame().style.visibility, "visible");
  assert.notEqual(harness.lastPosted().xmatrixAsk, "dock");

  // Pressing Escape minimizes the active thread to the right-edge dock tab.
  harness.pressEscape();
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");
  harness.reportSize({ width: 72, height: 80, topInset: 16, bottomInset: 20, leftInset: 24, rightInset: 0 });
  assert.equal(harness.frame().style.right, "0px");
  assert.equal(harness.frame().style.left, "auto");
  assert.equal(harness.frame().style.visibility, "visible");

  // Clicking outside or scrolling never dismisses the right-edge dock tab.
  harness.clickOutside();
  harness.scroll();
  assert.equal(harness.frame().style.visibility, "visible");

  // B5: Moving tab to background notifies the frame to release any warm off-screen App.
  harness.setVisibility(true);
  assert.equal(harness.lastPosted().xmatrixAsk, "visibility");
  assert.equal(harness.lastPosted().hidden, true);
});

test("shows the right-edge dock tab when the side panel closes on a page with an active thread, and hides it when open", async () => {
  const harness = mountSelectionScript({ width: 1280, height: 800 });
  // Side panel closes on a page that has a thread -> dock tab appears.
  harness.sendExtensionMessage({ type: "panel-state", open: false, hasThread: true });
  harness.ready();
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");
  harness.reportSize({ width: 72, height: 80, topInset: 16, bottomInset: 20, leftInset: 24, rightInset: 0 });
  assert.equal(harness.frame().style.right, "0px");
  assert.equal(harness.frame().style.visibility, "visible");

  // Side panel opens -> hides dock visually, waits for panel-release before releasing warm App, and switches selections to quote mode.
  harness.sendExtensionMessage({ type: "panel-state", open: true, hasThread: true });
  assert.equal(harness.frame().style.visibility, "hidden");
  harness.sendExtensionMessage({ type: "panel-release" });
  assert.equal(harness.lastPosted().xmatrixAsk, "release");

  await harness.select("quoted passage", { top: 200, bottom: 224, left: 160, width: 180, height: 24 });
  const prepared = harness.lastPosted();
  assert.equal(prepared.xmatrixAsk, "prepared");
  assert.equal(prepared.mode, "quote");
});

test("mounts directly into right-edge dock when page already has a thread and panel is closed", async () => {
  const harness = mountSelectionScript({
    width: 1280,
    height: 800,
    initialPageState: { panelOpen: false, hasThread: true },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(harness.frame(), "iframe is mounted automatically for right-edge dock");
  harness.ready();
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");
});

test("selecting text on a page that already has a conversation opens the full inline thread card, not a bare ask box", async () => {
  let pageHasThread = true;
  const harness = mountSelectionScript({
    width: 1280,
    height: 800,
    initialPageState: { panelOpen: false, hasThread: true },
    prepareState: () => ({ panelOpen: false, hasThread: pageHasThread }),
  });
  await Promise.resolve();
  await Promise.resolve();
  harness.ready();
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");

  // Highlighting a single short sentence in the upper half opens the full conversation card below it.
  await harness.select("another passage on same page", { top: 220, bottom: 244, left: 160, width: 220, height: 24 });
  const preparedThread = harness.lastPosted();
  assert.equal(preparedThread.xmatrixAsk, "prepared");
  assert.equal(preparedThread.mode, "thread");
  assert.equal(preparedThread.placement, "below");

  // Escape returns to right-edge dock.
  harness.pressEscape();
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");

  // Highlighting a single sentence near the bottom of the viewport flips the full thread card cleanly above it.
  await harness.select("bottom sentence on same page", { top: 620, bottom: 644, left: 160, width: 200, height: 24 });
  const preparedAbove = harness.lastPosted();
  assert.equal(preparedAbove.xmatrixAsk, "prepared");
  assert.equal(preparedAbove.mode, "thread");
  assert.equal(preparedAbove.placement, "above");
  harness.reportSize({ width: 528, height: 488, topInset: 12, bottomInset: 36, leftInset: 24, rightInset: 24 });
  assert.equal(
    parseFloat(harness.frame().style.top) + parseFloat(harness.frame().style.height) - 36,
    612,
    "thread card bottom stays 8px above the bottom selection without covering it",
  );
  harness.pressEscape();

  // On an SPA route change to a page without a thread, askPrepare reconciles back to a fresh ask capsule.
  pageHasThread = false;
  await harness.select("brand new page passage", { top: 180, bottom: 204, left: 160, width: 200, height: 24 });
  const preparedAsk = harness.lastPosted();
  assert.equal(preparedAsk.xmatrixAsk, "prepared");
  assert.equal(preparedAsk.mode, "ask");
});

async function mountThreadedSelection({ ready = true } = {}) {
  const harness = mountSelectionScript({
    width: 1280,
    height: 800,
    initialPageState: { panelOpen: false, hasThread: true },
    prepareState: { panelOpen: false, hasThread: true },
  });
  await Promise.resolve();
  await Promise.resolve();
  if (ready) harness.ready();
  return harness;
}

test("mouse drag or Shift+Arrow keyboard selection updates an open inline thread without flashing dock", async () => {
  const harness = await mountThreadedSelection();

  await harness.select("first highlighted sentence", { top: 180, bottom: 204, left: 160, width: 200, height: 24 });
  harness.reportSize({ width: 528, height: 488, topInset: 12, bottomInset: 36, leftInset: 24, rightInset: 24 });
  const beforeCount = harness.posted().length;

  // Dragging a new selection while the thread card is open transitions directly to the new selection without docking.
  await harness.dragSelect("second highlighted sentence", { top: 300, bottom: 324, left: 160, width: 220, height: 24 });
  const postedDuringDrag = harness.posted().slice(beforeCount);
  assert.ok(!postedDuringDrag.some((msg) => msg.xmatrixAsk === "dock"), "dock tab never flashes during re-selection");
  assert.equal(postedDuringDrag.at(-1)?.xmatrixAsk, "prepared");
  assert.equal(postedDuringDrag.at(-1)?.mode, "thread");

  // D2: Keyboard Shift+Arrow selection while the thread card is open also updates the passage directly.
  const beforeKeyCount = harness.posted().length;
  await harness.keyboardSelect("keyboard expanded sentence", { top: 300, bottom: 324, left: 160, width: 280, height: 24 });
  const postedDuringKey = harness.posted().slice(beforeKeyCount);
  assert.ok(!postedDuringKey.some((msg) => msg.xmatrixAsk === "dock"));
  assert.equal(postedDuringKey.at(-1)?.xmatrixAsk, "prepared");
  assert.equal(postedDuringKey.at(-1)?.mode, "thread");

  // Closing via × (`mode: "dock"`) docks cleanly.
  harness.sendFromFrame({ type: "mode", mode: "dock" });
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");
});

test("drag-start prewarms a docked thread and SPA page-updated forwards new URL/title to the open card", async () => {
  const harness = await mountThreadedSelection();
  assert.equal(harness.lastPosted().xmatrixAsk, "dock");

  // Starting a selection drag while docked prewarms the real App before mouseup (Item 4).
  await harness.select("prewarm trigger", { top: 160, bottom: 184, left: 120, width: 140, height: 24 });
  assert.ok(harness.posted().some((msg) => msg.xmatrixAsk === "prewarm"), "prewarm sent during selection drag");

  // SPA navigation while thread card is open forwards page-updated immediately (Item 2).
  harness.sendExtensionMessage({ type: "page-updated", title: "Next Tweet", href: "https://x.com/daniel/status/2" });
  assert.equal(harness.lastPosted().xmatrixAsk, "page-updated");
  assert.equal(harness.lastPosted().title, "Next Tweet");
  assert.equal(harness.lastPosted().href, "https://x.com/daniel/status/2");
});

test("re-selecting text while ask capsule is open preserves draft, while clicking away or Esc resets it", async () => {
  const harness = mountSelectionScript({ width: 1280, height: 800 });
  await harness.select("first selection", { top: 140, bottom: 164, left: 160, width: 160, height: 24 });
  harness.ready();
  assert.equal(harness.lastPosted().mode, "ask");

  // Dragging a new selection while ask is open must NOT send reset-draft between mousedown and mouseup (Item 6).
  const beforeDrag = harness.posted().length;
  await harness.dragSelect("second selection", { top: 240, bottom: 264, left: 160, width: 160, height: 24 });
  const postedDuringDrag = harness.posted().slice(beforeDrag);
  assert.ok(!postedDuringDrag.some((msg) => msg.xmatrixAsk === "reset-draft"), "draft preserved across re-selection");
  assert.equal(postedDuringDrag.at(-1)?.xmatrixAsk, "prepared");
  assert.equal(postedDuringDrag.at(-1)?.mode, "ask");

  // Plain click away (no new selection) DOES send reset-draft on mouseup.
  const beforeClick = harness.posted().length;
  harness.clickOutside();
  assert.ok(harness.posted().slice(beforeClick).some((msg) => msg.xmatrixAsk === "reset-draft"), "draft cleared on click-away");

  // Pressing Escape also clears draft immediately.
  await harness.select("third selection", { top: 140, bottom: 164, left: 160, width: 160, height: 24 });
  const beforeEsc = harness.posted().length;
  harness.pressEscape();
  assert.ok(harness.posted().slice(beforeEsc).some((msg) => msg.xmatrixAsk === "reset-draft"), "draft cleared on Escape");
});

test("panel-state hides inline card visually without premature release, and panel-release unmounts it", async () => {
  const harness = await mountThreadedSelection({ ready: false });
  await harness.select("open card", { top: 160, bottom: 184, left: 120, width: 140, height: 24 });
  harness.ready();

  // Opening the side panel hides the inline frame visually, without prematurely sending release.
  const beforePanelOpen = harness.posted().length;
  harness.sendExtensionMessage({ type: "panel-state", open: true, hasThread: true });
  assert.equal(harness.frame().style.visibility, "hidden");
  assert.ok(!harness.posted().slice(beforePanelOpen).some((msg) => msg.xmatrixAsk === "release"));

  // Once the side panel confirms it has displayed the conversation, panel-release unmounts the inline App.
  harness.sendExtensionMessage({ type: "panel-release" });
  assert.equal(harness.lastPosted().xmatrixAsk, "release");
});

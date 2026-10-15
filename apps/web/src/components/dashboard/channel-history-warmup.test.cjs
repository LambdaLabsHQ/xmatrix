const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");
const compiled = compileTsModules(__dirname, ["channel-history-warmup"]);
const { channelsToWarmHistory, warmedHistoryWindow, HISTORY_WARMUP_RETRY_MS } = compiled.exports;
test.after(compiled.dispose);

const channel = (id, spaceId = "space-a", head = 5) => ({ id, spaceId, historyHeadSequence: head });

function targets(overrides = {}) {
  return channelsToWarmHistory({
    channels: [channel("a"), channel("b"), channel("c")],
    spaceId: "space-a",
    selectedChannelId: null,
    hasCurrentHistory: () => false,
    lastAttemptAt: () => undefined,
    now: 1_000_000,
    ...overrides,
  });
}

test("reads ahead the Space's most recent Channels in catalog order", () => {
  assert.deepEqual(targets(), ["a", "b", "c"]);
});

test("only the top of the Space's list is considered, so reads stay bounded", () => {
  const channels = [channel("x", "space-b"), channel("a"), channel("b"), channel("c")];
  assert.deepEqual(targets({ channels, limit: 2 }), ["a", "b"]);
  assert.deepEqual(targets({ channels, limit: 2, hasCurrentHistory: (id) => id === "a" }), ["b"]);
});

test("skips the open Channel, empty Channels, and current windows", () => {
  const channels = [channel("a"), channel("empty", "space-a", 0), { id: "unknown", spaceId: "space-a" }, channel("c")];
  assert.deepEqual(targets({ channels, selectedChannelId: "a", hasCurrentHistory: (id) => id === "c" }), []);
  assert.deepEqual(targets({ channels: [{ id: "legacy", spaceId: "space-a", messageCount: 3 }] }), ["legacy"]);
});

test("a recent attempt is not repeated until the retry window passes", () => {
  const now = 1_000_000;
  assert.deepEqual(targets({ now, lastAttemptAt: (id) => (id === "a" ? now - 1 : undefined) }), ["b", "c"]);
  assert.deepEqual(targets({ now, lastAttemptAt: () => now - HISTORY_WARMUP_RETRY_MS }), ["a", "b", "c"]);
});

test("a warmed window keeps live rows newer than its page and drops older held rows", () => {
  const row = (sequence) => ({ messageId: `m${sequence}`, sequence });
  const page = [row(4), row(5), row(6)];
  // m1 is behind a gap the page does not bridge; m7 arrived live during the read.
  assert.deepEqual(warmedHistoryWindow(page, [row(1), row(5), row(7)]).map((message) => message.messageId),
    ["m4", "m5", "m6", "m7"]);
  assert.deepEqual(warmedHistoryWindow(page, []), page);
});

test("a cached window is read again when the list shows it behind, or the socket dropped since", () => {
  const channels = [channel("a"), channel("b"), channel("c")];
  const held = { a: 5, b: 4, c: 5 };
  const contiguous = new Set(["a", "b"]);
  assert.deepEqual(targets({
    channels,
    hasCurrentHistory: (id, head) => held[id] >= head && contiguous.has(id),
  }), ["b", "c"]);
});

test("a newer head is a new read, however recent the last one", () => {
  const now = 1_000_000;
  const readAt = { a: 5, b: 4 };
  assert.deepEqual(targets({
    now,
    lastAttemptAt: (id, head) => (readAt[id] !== undefined && readAt[id] >= head ? now - 1 : undefined),
  }), ["b", "c"]);
});

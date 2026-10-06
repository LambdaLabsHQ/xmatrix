const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");
const compiled = compileTsModules(__dirname, ["channel-history-warmup"]);
const { channelsToWarmHistory, HISTORY_WARMUP_RETRY_MS } = compiled.exports;
test.after(compiled.dispose);

const channel = (id, spaceId = "space-a", head = 5) => ({ id, spaceId, historyHeadSequence: head });

function targets(overrides = {}) {
  return channelsToWarmHistory({
    channels: [channel("a"), channel("b"), channel("c")],
    spaceId: "space-a",
    selectedChannelId: null,
    hasCachedHistory: () => false,
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
  assert.deepEqual(targets({ channels, limit: 2, hasCachedHistory: (id) => id === "a" }), ["b"]);
});

test("skips the open Channel, empty Channels, and cached windows", () => {
  const channels = [channel("a"), channel("empty", "space-a", 0), { id: "unknown", spaceId: "space-a" }, channel("c")];
  assert.deepEqual(targets({ channels, selectedChannelId: "a", hasCachedHistory: (id) => id === "c" }), []);
  assert.deepEqual(targets({ channels: [{ id: "legacy", spaceId: "space-a", messageCount: 3 }] }), ["legacy"]);
});

test("a recent attempt is not repeated until the retry window passes", () => {
  const now = 1_000_000;
  assert.deepEqual(targets({ now, lastAttemptAt: (id) => (id === "a" ? now - 1 : undefined) }), ["b", "c"]);
  assert.deepEqual(targets({ now, lastAttemptAt: () => now - HISTORY_WARMUP_RETRY_MS }), ["a", "b", "c"]);
});

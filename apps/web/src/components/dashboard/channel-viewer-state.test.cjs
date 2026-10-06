const assert = require("node:assert/strict");
const { test } = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { mergeChannelViewerState } = require("./channel-viewer-state.ts");

const attention = {
  channelId: "channel-1",
  unreadAttentionCount: 1,
  updatedAt: "2026-08-21T06:00:00.000Z",
};

test("an authoritative catalog clears viewer state that it omits", () => {
  const state = mergeChannelViewerState(
    { attention, readSequence: 7 },
    {},
    "authoritative",
  );

  assert.deepEqual(state, { attention: undefined, readSequence: undefined });
});

test("a partial shared update preserves the viewer's local state", () => {
  const state = mergeChannelViewerState(
    { attention, readSequence: 7 },
    {},
    "partial",
  );

  assert.deepEqual(state, { attention, readSequence: 7 });
});

test("new viewer state overrides an older local projection", () => {
  const nextAttention = { ...attention, unreadAttentionCount: 2 };
  const state = mergeChannelViewerState(
    { attention, readSequence: 7 },
    { attention: nextAttention, readSequence: 9 },
    "partial",
  );

  assert.deepEqual(state, { attention: nextAttention, readSequence: 9 });
});

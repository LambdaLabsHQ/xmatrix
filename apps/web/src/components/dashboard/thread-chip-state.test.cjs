const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { threadChipState } = require("./thread-chip-state.ts");

test("a message without an opened thread has no chip", () => {
  assert.deepEqual(threadChipState({}), { present: false, label: "" });
});

test("the chip counts replies, and shows as soon as the thread id is known", () => {
  assert.deepEqual(threadChipState({ threadChannelId: "t", threadReplyCount: 1 }),
    { present: true, label: "1 reply · View in thread" });
  assert.deepEqual(threadChipState({ threadChannelId: "t", threadReplyCount: 3 }),
    { present: true, label: "3 replies · View in thread" });
  assert.deepEqual(threadChipState({ threadChannelId: "t" }),
    { present: true, label: "0 replies · View in thread" });
});

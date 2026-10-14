const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { channelNotAheadOfTimeline, createPresentedChannelTail } = require("./presented-channel-tail.ts");

const preview = (messageId, sentAt, bodyPreview = messageId) => ({ messageId, sentAt, bodyPreview, from: { label: "Agent" } });
const channel = (id, lastMessage) => ({ id, spaceId: "space", name: id, lastMessage });

test("the open conversation's row waits for its timeline to show a newer message", () => {
  const tail = { channelId: "open", sequence: 1, preview: preview("m1", "2026-10-14T09:00:00.000Z") };
  const ahead = { ...channel("open", preview("m2", "2026-10-14T09:00:01.000Z")), messageCount: 2 };
  const held = channelNotAheadOfTimeline(ahead, tail);
  assert.deepEqual(held.lastMessage, tail.preview);
  assert.equal(held.messageCount, 1, "nor counts it unread");
  // Once the timeline shows it, the row shows it, as the Channel it was.
  const caughtUp = { channelId: "open", sequence: 2, preview: preview("m2", "2026-10-14T09:00:01.000Z") };
  assert.equal(channelNotAheadOfTimeline(ahead, caughtUp), ahead);
});

test("every other row, and a row whose timeline is not painted, shows what the Channel says", () => {
  const other = channel("other", preview("m9", "2026-10-14T09:05:00.000Z"));
  const tail = { channelId: "open", sequence: 1, preview: preview("m1", "2026-10-14T09:00:00.000Z") };
  assert.equal(channelNotAheadOfTimeline(other, tail), other);
  assert.equal(channelNotAheadOfTimeline(other, null), other);
  const older = channel("open", preview("m0", "2026-10-14T08:59:00.000Z"));
  assert.equal(channelNotAheadOfTimeline(older, tail), older);
});

test("a row hears only a change to its own Channel's tail", () => {
  const store = createPresentedChannelTail();
  const heard = [];
  store.subscribe("a", () => heard.push("a"));
  store.subscribe("b", () => heard.push("b"));
  const first = { channelId: "a", sequence: 1, preview: preview("m1", "2026-10-14T09:00:00.000Z") };
  store.set(first);
  store.set({ channelId: "a", sequence: 1, preview: { ...first.preview } });
  assert.deepEqual(heard, ["a"], "the same tail again tells no one");
  store.set({ channelId: "b", sequence: 5, preview: preview("m5", "2026-10-14T09:01:00.000Z") });
  assert.deepEqual(heard, ["a", "a", "b"], "opening another conversation tells the one left and the one opened");
  assert.equal(store.get("a"), null);
  assert.equal(store.get("b").preview.messageId, "m5");
  store.set(null);
  assert.equal(store.get("b"), null);
});

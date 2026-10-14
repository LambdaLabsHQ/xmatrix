const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { channelAsTimelineShows, createPresentedChannelTail } = require("./presented-channel-tail.ts");

const preview = (messageId, sentAt, bodyPreview = messageId) => ({ messageId, sentAt, bodyPreview, from: { label: "Agent" } });
const channel = (id, lastMessage, messageCount) => ({ id, spaceId: "space", name: id, lastMessage, messageCount });

test("the open conversation's row says what its timeline shows, not what a snapshot says", () => {
  const tail = { channelId: "open", sequence: 1, preview: preview("m1", "2026-10-14T09:00:00.000Z") };
  const ahead = channel("open", preview("m2", "2026-10-14T09:00:01.000Z"), 2);
  const shown = channelAsTimelineShows(ahead, tail);
  assert.deepEqual(shown.lastMessage, tail.preview);
  assert.equal(shown.messageCount, 1, "nor counts a message the timeline does not show");
  // When both say the same, the row keeps the Channel it was given.
  const caughtUp = { channelId: "open", sequence: 2, preview: { ...ahead.lastMessage } };
  assert.equal(channelAsTimelineShows(ahead, caughtUp), ahead);
});

test("every other row shows what its Channel says", () => {
  const other = channel("other", preview("m9", "2026-10-14T09:05:00.000Z"), 9);
  const tail = { channelId: "open", sequence: 1, preview: preview("m1", "2026-10-14T09:00:00.000Z") };
  assert.equal(channelAsTimelineShows(other, tail), other);
  assert.equal(channelAsTimelineShows(other, null), other);
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

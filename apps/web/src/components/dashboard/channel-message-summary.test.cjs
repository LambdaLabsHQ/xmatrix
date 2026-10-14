const assert = require("node:assert/strict");
const test = require("node:test");
const { installTypeScriptRequire } = require("./typescript-require.cjs");
installTypeScriptRequire();
const { channelAfterMessage } = require("./channel-message-summary.ts");

const AT = "2026-10-13T12:00:00.000Z";
const LATER = "2026-10-13T12:00:05.000Z";
const EARLIER = "2026-10-13T11:59:00.000Z";

function channel(extra = {}) {
  return {
    id: "c1", name: "general", messageCount: 40, historyHeadSequence: 40, readSequence: 40, updatedAt: AT,
    lastMessage: { messageId: "m40", bodyPreview: "forty", sentAt: AT, from: { kind: "user", label: "A" } },
    ...extra,
  };
}

function arrival(sequence, sentAt, extra = {}) {
  const entry = { messageId: `m${sequence ?? "x"}`, channelId: "c1", body: `body ${sequence}`, sentAt, sequence,
    from: { kind: "agent", label: "Codex" } };
  return {
    entry,
    preview: { messageId: entry.messageId, bodyPreview: entry.body, sentAt, from: entry.from },
    known: false, historyCount: 0, activity: false, ...extra,
  };
}

test("a new message moves the count, the head, the activity time and the preview forward", () => {
  const next = channelAfterMessage(channel(), arrival(41, LATER));
  assert.equal(next.messageCount, 41);
  assert.equal(next.historyHeadSequence, 41);
  assert.equal(next.updatedAt, LATER);
  assert.equal(next.lastMessage.messageId, "m41");
  // Somebody else's ordinary message is not read by arriving.
  assert.equal(next.readSequence, 40);
});

test("the same frame twice changes nothing and hands back the Channel itself", () => {
  const once = channelAfterMessage(channel(), arrival(41, LATER));
  assert.equal(channelAfterMessage(once, arrival(41, LATER, { known: true })), once);
});

test("an echo without a sequence is counted once", () => {
  const first = channelAfterMessage(channel(), arrival(undefined, LATER));
  assert.equal(first.messageCount, 41);
  const echoed = channelAfterMessage(first, arrival(undefined, LATER, { known: true }));
  assert.equal(echoed.messageCount, 41);
  assert.equal(echoed, first);
});

test("a frame that comes late leaves the newer preview, time and count as they are", () => {
  const current = channelAfterMessage(channel(), arrival(42, LATER));
  const late = channelAfterMessage(current, arrival(41, EARLIER));
  assert.equal(late.messageCount, 42);
  assert.equal(late.historyHeadSequence, 42);
  assert.equal(late.updatedAt, LATER);
  assert.equal(late.lastMessage.messageId, "m42");
});

test("an edit of the newest message replaces its preview", () => {
  const current = channelAfterMessage(channel(), arrival(41, LATER));
  const edited = arrival(41, LATER, { known: true });
  edited.preview = { ...edited.preview, bodyPreview: "edited" };
  assert.equal(channelAfterMessage(current, edited).lastMessage.bodyPreview, "edited");
});

test("an activity entry keeps a caught-up reader caught up, and nobody else", () => {
  assert.equal(channelAfterMessage(channel(), arrival(41, LATER, { activity: true })).readSequence, 41);
  assert.equal(channelAfterMessage(channel({ readSequence: 30 }), arrival(41, LATER, { activity: true })).readSequence, 30);
  // A cursor the Hub never sent stays missing rather than becoming zero.
  const unread = channelAfterMessage(channel({ readSequence: undefined }), arrival(41, LATER, { activity: true }));
  assert.equal("readSequence" in unread && unread.readSequence !== undefined, false);
});

test("a merged history that holds more than the list knew raises the count", () => {
  assert.equal(channelAfterMessage(channel({ messageCount: 3 }), arrival(undefined, LATER, { historyCount: 12 })).messageCount, 12);
});

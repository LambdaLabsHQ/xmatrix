const assert = require("node:assert/strict");
const test = require("node:test");
const { installTypeScriptRequire } = require("./typescript-require.cjs");
installTypeScriptRequire();
const { channelAfterMessage, createViewerReads } = require("./channel-message-summary.ts");

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

const LATEST = "2026-10-13T12:00:09.000Z";
const unread = (item) => item.messageCount - (item.readSequence ?? 0);

test("a read taken between two messages of a Channel nobody knew ends with both of them", () => {
  const reads = createViewerReads();
  // 41 arrives for a Channel no read has brought, and asks for it; 42 arrives before the answer.
  reads.hold(arrival(41, LATER));
  reads.hold(arrival(42, LATEST));
  assert.equal(reads.has("c1"), false);
  // The Hub answered as of 41.
  const read = channel({ messageCount: 41, historyHeadSequence: 41, updatedAt: LATER,
    lastMessage: { messageId: "m41", bodyPreview: "body 41", sentAt: LATER, from: { kind: "agent", label: "Codex" } } });
  const settled = reads.settle(read);
  assert.equal(reads.has("c1"), true);
  assert.equal(settled.messageCount, 42);
  assert.equal(settled.historyHeadSequence, 42);
  assert.equal(settled.updatedAt, LATEST);
  assert.equal(settled.lastMessage.messageId, "m42");
  // What the reader had read is the Hub's to say: 41 and 42 are unread.
  assert.equal(unread(settled), 2);
  // The messages were applied once: the next read is taken as it comes.
  assert.equal(reads.settle(read), read);
});

test("an activity entry that got ahead of the read keeps a caught-up reader caught up", () => {
  const reads = createViewerReads();
  reads.hold(arrival(42, LATEST, { activity: true }));
  const settled = reads.settle(channel({ messageCount: 41, historyHeadSequence: 41, readSequence: 41 }));
  assert.equal(settled.messageCount, 42);
  assert.equal(unread(settled), 0);
});

test("a Channel only a shared presence frame has shown is not the reader's until their read lands", () => {
  const reads = createViewerReads();
  // The shared frame carries no read state; message 41 is applied to it live and kept for the read.
  const shared = channel({ readSequence: undefined, attention: undefined });
  const live = channelAfterMessage(shared, arrival(41, LATER));
  reads.hold(arrival(41, LATER));
  assert.equal(reads.has("c1"), false);
  assert.equal(live.readSequence, undefined);
  // The reader's read is older than the message: they had read 40 of 40.
  const settled = reads.settle(channel({ attention: { unreadAttentionCount: 0 } }));
  assert.equal(reads.has("c1"), true);
  assert.equal(settled.readSequence, 40);
  assert.equal(unread(settled), 1);
});

test("messages waiting for a read that never comes do not pile up", () => {
  const reads = createViewerReads();
  const held = (id, sequence) => ({ ...arrival(sequence, LATER), entry: { ...arrival(sequence, LATER).entry, channelId: id } });
  for (let index = 0; index < 600; index += 1) reads.hold(held(`c${index}`, 41));
  // The longest waiting were let go; a later message or read says as much for them.
  assert.equal(reads.settle(channel({ id: "c0" })).messageCount, 40);
  assert.equal(reads.settle(channel({ id: "c599" })).messageCount, 41);
  for (let sequence = 41; sequence < 141; sequence += 1) reads.hold(arrival(sequence, LATER));
  assert.equal(reads.settle(channel()).messageCount, 140);
});

test("emptying the entity table ends what the reader's reads had brought", () => {
  // The owner makes a new one whenever the table is emptied: nothing carries over.
  const before = createViewerReads();
  before.settle(channel());
  before.hold(arrival(41, LATER));
  const after = createViewerReads();
  assert.equal(before.has("c1"), true);
  assert.equal(after.has("c1"), false);
  assert.equal(after.settle(channel()).messageCount, 40);
});

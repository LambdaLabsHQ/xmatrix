const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const history = compileTsModules(__dirname, ["channel-history", "time-display"]);

const {
  compactChannelHistoryWindow,
  filterHistoryForChannel,
  formatMessageDateTime,
  formatMessageTimestamp,
  mergeChannelHistory,
  commandResultHistoryMessage,
} = history.exports;

test.after(history.dispose);

/** `count` consecutive sequences starting at `first`. */
function sequences(first, count) {
  return Array.from({ length: count }, (_, index) => index + first);
}

test("formatMessageDateTime names the zone it rendered the message in", () => {
  /* This is the string a reader lifts out of the timeline — into a screenshot,
     a channel message, an agent prompt — so it has to survive the trip. The
     compact label keeps its zone-less form; only this one states the zone. */
  assert.equal(
    formatMessageDateTime("2026-12-31T16:30:00Z", "en-US", "Asia/Shanghai"),
    "1/1/2027, 12:30 AM GMT+8"
  );
  assert.equal(
    formatMessageDateTime("2026-12-31T16:30:00Z", "en-US", "UTC"),
    "12/31/2026, 4:30 PM UTC"
  );
});

test("formatMessageTimestamp progressively reveals older calendar context", () => {
  const referenceTime = new Date("2026-07-11T04:00:00Z");
  const format = (value) => formatMessageTimestamp(value, referenceTime, "en-US", "Asia/Shanghai");

  assert.equal(format("2026-07-11T03:00:00Z"), "11:00 AM", "today only needs the time");
  assert.equal(format("2026-07-10T03:00:00Z"), "Yesterday 11:00 AM");
  assert.equal(format("2026-07-07T03:00:00Z"), "Tue 11:00 AM", "recent days use the weekday");
  assert.equal(format("2026-07-01T03:00:00Z"), "7/1, 11:00 AM", "older dates in this year omit the year");
  assert.equal(format("2025-12-31T03:00:00Z"), "12/31/2025, 11:00 AM", "other years stay unambiguous");
});

test("formatMessageTimestamp uses the user's calendar day at timezone boundaries", () => {
  assert.equal(
    formatMessageTimestamp(
      "2026-07-10T15:30:00Z",
      new Date("2026-07-10T16:30:00Z"),
      "en-US",
      "Asia/Shanghai"
    ),
    "Yesterday 11:30 PM"
  );
});

test("formatMessageTimestamp localizes relative days and weekdays", () => {
  const referenceTime = new Date("2026-07-11T04:00:00Z");
  const format = (value) => formatMessageTimestamp(value, referenceTime, "zh-CN", "Asia/Shanghai");

  assert.equal(format("2026-07-10T03:00:00Z"), "昨天 11:00");
  assert.equal(format("2026-07-07T03:00:00Z"), "周二11:00");
});

test("filterHistoryForChannel rejects messages from other channels", () => {
  const messages = [
    { messageId: "a1", channelId: "a", sentAt: "2026-05-22T00:00:01Z" },
    { messageId: "b1", channelId: "b", sentAt: "2026-05-22T00:00:02Z" },
    { messageId: "missing-channel", sentAt: "2026-05-22T00:00:03Z" },
  ];

  assert.deepEqual(
    filterHistoryForChannel("a", messages).map((message) => message.messageId),
    ["a1"]
  );
});

test("a later page supersedes presented rows on the same messageId", () => {
  const online = [
    { messageId: "a1", channelId: "a", sequence: 1, sentAt: "2026-05-22T00:00:01Z", body: "online" },
    { messageId: "a2", channelId: "a", sequence: 2, sentAt: "2026-05-22T00:00:02Z", body: "online" },
  ];
  const presented = mergeChannelHistory("a", [], online);
  assert.deepEqual(presented.map((message) => message.body), ["online", "online"]);

  // Its rows supersede presented rows by messageId; older presented rows stay.
  const replica = [
    { messageId: "a2", channelId: "a", sequence: 2, sentAt: "2026-05-22T00:00:02Z", body: "verified" },
    { messageId: "a3", channelId: "a", sequence: 3, sentAt: "2026-05-22T00:00:03Z", body: "verified" },
  ];
  const converged = mergeChannelHistory("a", presented, replica);
  assert.deepEqual(
    converged.map((message) => [message.messageId, message.body]),
    [
      ["a1", "online"],
      ["a2", "verified"],
      ["a3", "verified"],
    ],
  );
});

test("mergeChannelHistory dedupes and never merges cross-channel messages", () => {
  const current = [
    { messageId: "a2", channelId: "a", sequence: 2, sentAt: "2026-05-22T00:00:02Z" },
    { messageId: "b1", channelId: "b", sequence: 1, sentAt: "2026-05-22T00:00:01Z" },
  ];
  const incoming = [
    { messageId: "a1", channelId: "a", sequence: 1, sentAt: "2026-05-22T00:00:01Z" },
    { messageId: "a2", channelId: "a", sequence: 2, sentAt: "2026-05-22T00:00:03Z", body: "edited" },
    { messageId: "b2", channelId: "b", sequence: 3, sentAt: "2026-05-22T00:00:03Z" },
  ];

  const merged = mergeChannelHistory("a", current, incoming);

  assert.deepEqual(
    merged.map((message) => [message.messageId, message.channelId, message.body]),
    [
      ["a1", "a", undefined],
      ["a2", "a", "edited"],
    ]
  );
});

test("a compacted cache advertises omitted history instead of claiming exact EOF", () => {
  const messages = Array.from({ length: 121 }, (_, index) => ({
    messageId: `a${index + 1}`,
    channelId: "a",
    sequence: index + 1,
    sentAt: new Date((index + 1) * 1000).toISOString(),
  }));
  const compacted = compactChannelHistoryWindow("a", messages, false, 120);

  assert.deepEqual(compacted.messages.map((message) => message.sequence),
    sequences(2, 120));
  assert.equal(compacted.hasOlderMessages, true);
});

test("a send's own reply never erases the answer the Hub already pushed for it", () => {
  const sent = { messageId: "m1", channelId: "a", sequence: 4, sentAt: "2026-10-22T08:29:03.019Z", body: "@claude:1 /effort max" };
  const controls = [{ kind: "effort", target: "claude:1", status: "switched", selected: "max" }];
  // The answer arrives first, on the echo the reader holds.
  const answered = commandResultHistoryMessage([sent], { messageId: "m1", annotationId: "a1", payload: { controls } });
  const held = mergeChannelHistory("a", [], [answered]);
  // Then the send returns the message as committed, before any answer.
  const [merged] = mergeChannelHistory("a", held, [{ ...sent, mentionReadStatuses: [] }]);
  assert.deepEqual(merged.commandResult, { controls });
  assert.deepEqual(merged.mentionReadStatuses, [], "the newer frame's own fields still apply");
  // A recall is the one frame that does end what the Hub judged.
  const [recalled] = mergeChannelHistory("a", [merged], [{ ...sent, body: "", recalledAt: "2026-10-22T08:30:00Z" }]);
  assert.equal(recalled.commandResult, undefined);
});

test("partial history and live command answers converge in either order without losing a Run's result", () => {
  const message = { messageId: "summon", channelId: "a", sentAt: "2026-10-22T00:00:00Z", body: "@auto" };
  const fallback = { id: "fallback", text: "Trying another Machine", at: "2026-10-22T00:00:01Z", runId: "first" };
  const failure = { id: "failure", text: "The replacement failed to start", at: "2026-10-22T00:00:02Z", runId: "second" };
  const snapshot = { ...message, commandResult: { notes: [fallback] } };
  const live = { messageId: message.messageId, annotationId: failure.id, payload: { note: failure } };
  const pushed = commandResultHistoryMessage([message], live);
  const [lateHistory] = mergeChannelHistory("a", [pushed], [snapshot]);
  const earlyHistory = commandResultHistoryMessage([snapshot], live);
  assert.deepEqual(lateHistory.commandResult, { notes: [fallback, failure] });
  assert.deepEqual(lateHistory.commandResult, earlyHistory.commandResult);
  const [replayed] = mergeChannelHistory("a", [lateHistory], [snapshot, lateHistory]);
  assert.deepEqual(replayed.commandResult, lateHistory.commandResult, "replays never duplicate a fact");
  assert.deepEqual(pushed.commandResult.notes, [failure], "held snapshots are not mutated");
});

test("a partial note snapshot cannot erase a switch's answer and a stale note cannot undo its correction", () => {
  const message = { messageId: "stop", channelId: "a", sentAt: "2026-10-22T00:00:00Z" };
  const controls = [{ kind: "effort", target: "claude:1", status: "switched", selected: "max" }];
  const waiting = { id: "stop", text: "Waiting for the Machine", at: "2026-10-22T00:00:01Z" };
  const confirmed = { ...waiting, text: "Stopped", at: "2026-10-22T00:00:02Z", stopOutcome: "stopped" };
  const held = { ...message, commandResult: { controls, notes: [confirmed] } };
  const snapshot = { ...message, commandResult: { notes: [waiting] } };
  const [merged] = mergeChannelHistory("a", [held], [snapshot]);
  assert.deepEqual(merged.commandResult, held.commandResult);
  const staleEvent = commandResultHistoryMessage([merged], { messageId: message.messageId,
    annotationId: waiting.id, payload: { note: waiting } });
  assert.deepEqual(staleEvent.commandResult, held.commandResult, "live and history use the same fact merge");
});

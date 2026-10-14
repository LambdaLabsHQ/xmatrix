const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { ChannelReadSyncCoordinator, readCountsFromHub } = require("./channel-read-sync.ts");

function controlledTimers() {
  let nextId = 1;
  const timers = [];
  return {
    schedule(callback, delayMs) {
      const timer = { id: nextId++, callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
    pending() {
      return timers.filter((timer) => !timer.cancelled);
    },
    async runNext() {
      const timer = timers.find((candidate) => !candidate.cancelled);
      assert.ok(timer, "expected a pending timer");
      timer.cancelled = true;
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      return timer;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("rendered rows coalesce to one latest-sequence mutation", async () => {
  const timers = controlledTimers();
  const sent = [];
  const coordinator = new ChannelReadSyncCoordinator({
    send: async (channelId, sequence) => {
      sent.push({ channelId, sequence });
      return { readSequence: sequence };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.enqueue("channel-1", 3, { attentionUnread: false });
  coordinator.enqueue("channel-1", 8, { attentionUnread: false });
  coordinator.enqueue("channel-1", 5, { attentionUnread: false });

  assert.equal(timers.pending().length, 1);
  await timers.runNext();
  assert.deepEqual(sent, [{ channelId: "channel-1", sequence: 8 }]);
  assert.equal(timers.pending().length, 0);
});

test("one in-flight mutation queues only the latest newly exposed sequence", async () => {
  const timers = controlledTimers();
  const first = deferred();
  const sent = [];
  const coordinator = new ChannelReadSyncCoordinator({
    send: async (_channelId, sequence) => {
      sent.push(sequence);
      if (sent.length === 1) return first.promise;
      return { readSequence: sequence };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.enqueue("channel-1", 4, { attentionUnread: false });
  await timers.runNext();
  coordinator.enqueue("channel-1", 7, { attentionUnread: false });
  coordinator.enqueue("channel-1", 9, { attentionUnread: false });
  assert.deepEqual(sent, [4]);
  assert.equal(timers.pending().length, 0);

  first.resolve({ readSequence: 4 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.pending().length, 1);
  await timers.runNext();
  assert.deepEqual(sent, [4, 9]);
});

test("unread attention forces one reconciliation, not one request per render", async () => {
  const timers = controlledTimers();
  const sent = [];
  const coordinator = new ChannelReadSyncCoordinator({
    send: async (_channelId, sequence) => {
      sent.push(sequence);
      return { readSequence: sequence };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.observe("channel-1", 12);
  coordinator.enqueue("channel-1", 12, { attentionUnread: true });
  coordinator.enqueue("channel-1", 12, { attentionUnread: true });
  await timers.runNext();
  coordinator.enqueue("channel-1", 12, { attentionUnread: true });

  assert.deepEqual(sent, [12]);
  assert.equal(timers.pending().length, 0);
});

test("a transient failure keeps one backoff timer despite repeated exposure", async () => {
  const timers = controlledTimers();
  let attempts = 0;
  const coordinator = new ChannelReadSyncCoordinator({
    send: async () => {
      attempts += 1;
      return attempts === 1 ? undefined : { readSequence: 6 };
    },
    schedule: timers.schedule,
    cancel: timers.cancel,
    retryDelaysMs: [1_000, 5_000],
  });

  coordinator.enqueue("channel-1", 6, { attentionUnread: true });
  await timers.runNext();
  coordinator.enqueue("channel-1", 6, { attentionUnread: true });
  coordinator.enqueue("channel-1", 6, { attentionUnread: true });

  assert.equal(timers.pending().length, 1);
  assert.equal(timers.pending()[0].delayMs, 1_000);
  await timers.runNext();
  assert.equal(attempts, 2);
  assert.equal(timers.pending().length, 0);
});

test("reset cancels delayed work and ignores an older in-flight result", async () => {
  const timers = controlledTimers();
  const first = deferred();
  const successes = [];
  const coordinator = new ChannelReadSyncCoordinator({
    send: async () => first.promise,
    onSuccess: (_channelId, result) => successes.push(result),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  coordinator.enqueue("channel-1", 5, { attentionUnread: false });
  await timers.runNext();
  coordinator.reset();
  first.resolve({ readSequence: 5 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(successes, []);
  assert.equal(timers.pending().length, 0);
});

test("a read made on this device stands against a Hub answer given before it reached the Hub", () => {
  const readHere = { "channel-a": 42 };
  const current = { "channel-a": 42, "channel-b": 7 };
  // A message moved the Channel while the read was on its way: the Hub's last answer is older.
  const counts = readCountsFromHub(current, [
    { id: "channel-a", readSequence: 40, messageCount: 42 },
    { id: "channel-b", readSequence: 7, messageCount: 7 },
  ], (channelId) => readHere[channelId] ?? 0);
  assert.equal(counts, current, "nothing changed, so nothing is copied or written");
  // The Hub's answer stands again once it has gone past the read.
  assert.deepEqual(
    readCountsFromHub(current, [{ id: "channel-a", readSequence: 43, messageCount: 43 }], (channelId) => readHere[channelId] ?? 0),
    { "channel-a": 43, "channel-b": 7 },
  );
});

test("the Hub's answer replaces a count the device remembered without reading here", () => {
  assert.deepEqual(
    readCountsFromHub({ "channel-a": 50, "channel-b": 7 }, [{ id: "channel-a", readSequence: 45, messageCount: 50 }], () => 0),
    { "channel-a": 45, "channel-b": 7 },
  );
});

test("a Channel without read state starts from its message count and then keeps its count", () => {
  const first = readCountsFromHub({}, [{ id: "channel-a", messageCount: 5 }, { id: "channel-b" }], () => 0);
  assert.deepEqual(first, { "channel-a": 5 });
  assert.equal(readCountsFromHub(first, [{ id: "channel-a", messageCount: 9 }], () => 0), first);
});

test("a Done the Hub answers after a reset writes nothing, even when the same reader is back", async () => {
  const coordinator = new ChannelReadSyncCoordinator({ send: async () => undefined });
  const answer = deferred();
  const responding = coordinator.respond("channel-c", 42, () => answer.promise);
  // Another account signs in and reads the Channel to 7; then the first one is back.
  coordinator.reset();
  coordinator.noteRead("channel-c", 7);
  coordinator.reset();
  answer.resolve({ readSequence: 42 });
  assert.equal(await responding, null);
  assert.equal(coordinator.readHere("channel-c"), 0);
});

test("only a Done the Hub confirmed counts as read on this device", async () => {
  const coordinator = new ChannelReadSyncCoordinator({ send: async () => undefined });
  // Refused (401/403): no answer, so the Hub's next read state stands.
  assert.deepEqual(await coordinator.respond("channel-c", 42, async () => undefined), { answer: undefined });
  assert.equal(coordinator.readHere("channel-c"), 0);
  const confirmed = { readSequence: 42 };
  assert.deepEqual(await coordinator.respond("channel-c", 42, async () => confirmed), { answer: confirmed });
  assert.equal(coordinator.readHere("channel-c"), 42);
});

test("an answer that comes once another reader is here is nobody's, even before the reset", async () => {
  const timers = controlledTimers();
  let reader = "reader-a";
  const marked = deferred();
  const successes = [];
  const coordinator = new ChannelReadSyncCoordinator({
    send: async () => marked.promise,
    onSuccess: (_channelId, result) => successes.push(result),
    reader: () => reader,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  // Read on screen to 5, as the viewport reports it.
  coordinator.noteRead("channel-c", 5);
  coordinator.enqueue("channel-c", 5, { attentionUnread: false });
  await timers.runNext();
  const done = deferred();
  const responding = coordinator.respond("channel-c", 42, () => done.promise);
  // The next account has rendered; its reset has not run yet.
  reader = "reader-b";
  marked.resolve({ readSequence: 5 });
  done.resolve({ readSequence: 42 });
  assert.equal(await responding, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(successes, []);
  assert.equal(coordinator.readHere("channel-c"), 5, "the Done answered for the reader who left raises nothing");
  assert.equal(timers.pending().length, 0, "nothing is sent again for the reader who left");
});

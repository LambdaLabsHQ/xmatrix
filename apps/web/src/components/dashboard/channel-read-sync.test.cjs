const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { ChannelReadSyncCoordinator } = require("./channel-read-sync.ts");

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

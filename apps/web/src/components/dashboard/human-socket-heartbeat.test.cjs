const assert = require("node:assert/strict");
const { mock, test } = require("node:test");

async function load() {
  return await import("./human-socket-heartbeat.ts");
}

function heartbeatDeps(over = {}) {
  const calls = [];
  let open = true;
  return {
    calls,
    setOpen(next) {
      open = next;
    },
    deps: {
      pingIntervalMs: 20_000,
      pongTimeoutMs: 10_000,
      sendPing: () => calls.push("ping"),
      closeSocket: () => {
        open = false;
        calls.push("close");
      },
      isOpen: () => open,
      ...over,
    },
  };
}

/** Run `check` against a started heartbeat on mocked timers. */
async function withStartedHeartbeat(check) {
  const { createHumanSocketHeartbeat } = await load();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    const { calls, deps } = heartbeatDeps();
    const heartbeat = createHumanSocketHeartbeat(deps);
    heartbeat.start();
    check(heartbeat, calls);
  } finally {
    mock.timers.reset();
  }
}

test("an unanswered ping closes the half-open Human socket", () => withStartedHeartbeat((_heartbeat, calls) => {
  mock.timers.tick(19_000);
  assert.deepEqual(calls, []);
  mock.timers.tick(1_000);
  assert.deepEqual(calls, ["ping"]);
  mock.timers.tick(9_999);
  assert.deepEqual(calls, ["ping"]);
  mock.timers.tick(1);
  assert.deepEqual(calls, ["ping", "close"]);
}));

test("a pong disarms the deadline and keeps the Human socket", () => withStartedHeartbeat((heartbeat, calls) => {
  mock.timers.tick(20_000);
  heartbeat.noteInbound();
  mock.timers.tick(30_000);
  assert.deepEqual(calls, ["ping", "ping"]);
}));

test("a second probe does not push the pong deadline back", () => withStartedHeartbeat((heartbeat, calls) => {
  mock.timers.tick(20_000);
  heartbeat.probe();
  heartbeat.probe();
  assert.deepEqual(calls, ["ping", "ping", "ping"]);
  mock.timers.tick(10_000);
  assert.ok(calls.includes("close"), "the original deadline still fires");
}));

test("wake/focus probes an OPEN socket and reconnects a dead one", async () => {
  const { shouldResumeHumanSocketNow } = await load();
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: true, online: true, socketReadyState: 1 }),
    "wait",
  );
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: false, online: false, socketReadyState: 1 }),
    "wait",
  );
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: false, online: true, socketReadyState: 1 }),
    "probe",
  );
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: false, online: true, socketReadyState: 0 }),
    "wait",
  );
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: false, online: true, socketReadyState: null }),
    "reconnect",
  );
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: false, online: true, socketReadyState: 3 }),
    "reconnect",
  );
});

test("a resume after suspension replaces an OPEN or CONNECTING socket without a ping", async () => {
  const { shouldResumeHumanSocketNow } = await load();
  for (const socketReadyState of [0, 1]) {
    assert.equal(
      shouldResumeHumanSocketNow({ hidden: false, online: true, socketReadyState, suspended: true }),
      "replace",
    );
  }
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: false, online: true, socketReadyState: 3, suspended: true }),
    "reconnect",
  );
  assert.equal(
    shouldResumeHumanSocketNow({ hidden: true, online: true, socketReadyState: 1, suspended: true }),
    "wait",
  );
});

test("a long hidden stretch or a marked resume counts as a suspension", async () => {
  const { createHumanSocketSuspensionTracker } = await load();
  let clock = 0;
  const tracker = createHumanSocketSuspensionTracker(() => clock);
  assert.equal(tracker.consume(true), false);
  clock += 5_000;
  assert.equal(tracker.consume(false), false, "a short switch away keeps the socket");
  assert.equal(tracker.consume(true), false);
  clock += 30_000;
  assert.equal(tracker.consume(false), true);
  assert.equal(tracker.consume(false), false, "one suspension is consumed once");
  tracker.markSuspended();
  assert.equal(tracker.consume(true), false, "a hidden page waits until it is visible");
  assert.equal(tracker.consume(false), true);
});

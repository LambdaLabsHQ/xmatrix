const assert = require("node:assert/strict");
const test = require("node:test");

require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const win = new EventTarget();
const doc = Object.assign(new EventTarget(), { hidden: false });
globalThis.window = win;
globalThis.document = doc;
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor() {
    super();
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.closedWith = null;
  }
  send(data) { this.sent.push(data); }
  close(code) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  /** The server closed it. */
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
  receive(data) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}
globalThis.WebSocket = FakeSocket;

const { ReconnectingSocket, reconnectDelayMs } = require("./reconnecting-socket.ts");
const { createResumeTracker, SUSPENSION_GAP_MS } = require("./connectivity.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets = [];
  const downs = [];
  const connection = new ReconnectingSocket({
    open: async () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: () => {},
    onDown: () => downs.push(sockets.length),
    heartbeat: { intervalMs: 25_000, timeoutMs: 10_000, ping: (socket) => socket.send("ping") },
    backoff: { baseMs: 1_000, maxMs: 30_000 },
    random: () => 1,
    ...overrides,
  });
  t.after(() => connection.stop());
  return { connection, sockets, downs };
}

/** A connection whose first socket is open. */
async function opened(t, overrides) {
  const parts = harness(t, overrides);
  parts.connection.start();
  await flush();
  parts.sockets[0].open();
  return parts;
}

test("backoff is jittered, capped, and grows until the session works", () => {
  assert.equal(reconnectDelayMs(0, { baseMs: 1_000, maxMs: 30_000 }, () => 0), 500);
  assert.equal(reconnectDelayMs(0, { baseMs: 1_000, maxMs: 30_000 }, () => 1), 1_000);
  assert.equal(reconnectDelayMs(20, { baseMs: 1_000, maxMs: 30_000 }, () => 1), 30_000);
});

test("a close redials after backoff, and never opens a second socket", async (t) => {
  const { connection, sockets } = await opened(t);
  sockets[0].drop();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(sockets.length, 2);
  // A resume while the new socket dials must not open another one.
  win.dispatchEvent(new Event("focus"));
  await flush();
  assert.equal(sockets.length, 2);
});

test("the backoff resets only when the owner says the session works", async (t) => {
  const attempts = { current: 0 };
  const { connection, sockets } = await opened(t, { attempts });
  sockets[0].drop();
  await flush();
  assert.equal(attempts.current, 1, "opening alone is not proof");
  t.mock.timers.tick(1_000);
  await flush();
  sockets[1].open();
  connection.markHealthy();
  assert.equal(attempts.current, 0);
});

test("a socket that stops answering is replaced; our own probes cannot keep it alive", async (t) => {
  const { connection, sockets } = await opened(t);
  t.mock.timers.tick(25_000);
  assert.deepEqual(sockets[0].sent, ["ping"]);
  connection.probe();
  t.mock.timers.tick(9_999);
  assert.equal(sockets[0].closedWith, null);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(sockets[0].closedWith, 4000);
  assert.equal(sockets.length, 2);
});

test("any frame counts as an answer", async (t) => {
  const { connection, sockets } = await opened(t);
  t.mock.timers.tick(25_000);
  sockets[0].receive("pong");
  t.mock.timers.tick(10_000);
  assert.equal(sockets[0].closedWith, null);
});

test("a server that does not answer pings is never timed out", async (t) => {
  const { connection, sockets } = await opened(t, {
    heartbeat: { intervalMs: 25_000, timeoutMs: 10_000, ping: (socket) => socket.send("ping"), supported: () => false },
  });
  t.mock.timers.tick(60_000);
  assert.deepEqual(sockets[0].sent, []);
  assert.equal(sockets[0].closedWith, null);
});

test("a resume after a suspension replaces a socket that still says OPEN", async (t) => {
  const { connection, sockets } = await opened(t);
  win.dispatchEvent(new Event("xmatrix:native-resume"));
  await flush();
  assert.equal(sockets[0].closedWith, 4000);
  assert.equal(sockets.length, 2);
});

test("a resume with no socket dials at once instead of waiting out the backoff", async (t) => {
  const { connection, sockets } = harness(t, { attempts: { current: 6 } });
  connection.start();
  await flush();
  assert.equal(sockets.length, 0, "a re-created owner keeps backing off");
  win.dispatchEvent(new Event("online"));
  await flush();
  assert.equal(sockets.length, 1);
});

test("a dial that hangs is abandoned", async (t) => {
  const { connection, sockets } = harness(t);
  connection.start();
  await flush();
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(sockets[0].readyState, FakeSocket.CONNECTING);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(sockets.length, 2);
});

test("a close the owner decides is final does not redial", async (t) => {
  const { sockets } = await opened(t, { onClose: async () => "stop" });
  sockets[0].drop(4004);
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(sockets.length, 1);
});

test("every subscriber agrees whether the page was suspended", () => {
  let now = 0;
  const tracker = createResumeTracker(() => now);
  assert.equal(tracker.resume({ hidden: true, offline: false }), null);
  now += SUSPENSION_GAP_MS + 1;
  assert.deepEqual(tracker.resume({ hidden: false, offline: false }), { suspended: true, online: false });
  assert.deepEqual(tracker.resume({ hidden: false, offline: false }), { suspended: false, online: false });
  tracker.markSuspended();
  assert.equal(tracker.resume({ hidden: false, offline: true }), null, "offline cannot use it yet");
  assert.deepEqual(tracker.resume({ hidden: false, offline: false, online: true }), { suspended: true, online: true });
});

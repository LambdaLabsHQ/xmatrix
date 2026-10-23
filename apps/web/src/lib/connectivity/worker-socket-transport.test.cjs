const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { createWorkerSocketOpener } = require("./worker-socket-transport.ts");
const { installHumanSocketWorker } = require("./human-socket-worker.ts");

globalThis.CloseEvent ??= class CloseEvent extends Event {
  constructor(type, options) { super(type); Object.assign(this, options); }
};

function dispatch(target, type, properties) {
  target.dispatchEvent(Object.assign(new Event(type), properties));
}

class PhysicalSocket extends EventTarget {
  readyState = 0;
  sent = [];
  closed = [];
  open() { this.readyState = 1; dispatch(this, "open"); }
  send(value) { this.sent.push(value); }
  close(code = 1000, reason = "") {
    this.closed.push(code);
    this.drop(code, reason);
  }
  drop(code, reason = "") {
    this.readyState = 3;
    dispatch(this, "close", { code, reason, wasClean: code === 1000 });
  }
  receive(data) { dispatch(this, "message", { data }); }
}

/** Message-port boundary around the real worker owner, with a controlled network. */
class ControlledWorker extends EventTarget {
  commands = [];
  sockets = [];
  terminated = false;
  constructor() {
    super();
    installHumanSocketWorker({
      postMessage: (message) => queueMicrotask(() => {
        if (!this.terminated) dispatch(this, "message", { data: message });
      }),
      addEventListener: (_type, listener) => { this.command = listener; },
    }, (url) => {
      this.url = url;
      const socket = new PhysicalSocket();
      this.sockets.push(socket);
      return socket;
    });
  }
  postMessage(data) {
    this.commands.push(data);
    this.command({ data });
  }
  terminate() { this.terminated = true; }
  crash() { dispatch(this, "error"); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function transport(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workers = [];
  const native = [];
  const open = createWorkerSocketOpener({
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
    openNative: () => {
      const socket = new PhysicalSocket();
      native.push(socket);
      return socket;
    },
    ...overrides,
  });
  const socket = open("wss://hub.example/ws/humans?compat=exact");
  const received = [];
  const closes = [];
  socket.subscribePackets((packet) => received.push(packet));
  socket.addEventListener("close", (event) => closes.push(event));
  t.after(() => socket.dispose());
  return { open, socket, received, closes, workers, native };
}

async function startWorker(t, parts) {
  t.mock.timers.tick(0);
  await settle();
  const worker = parts.workers[0];
  worker.sockets[0].open();
  await settle();
  return { worker, physical: worker.sockets[0] };
}

test("Worker packets preserve every frame, request bytes, and close-code ordering", async (t) => {
  const parts = transport(t);
  const { worker, physical } = await startWorker(t, parts);
  assert.equal(worker.url, "wss://hub.example/ws/humans?compat=exact");
  parts.socket.send('{"type":"human_connect","token":"scoped","requestId":"subscribe"}');
  parts.socket.send('{"type":"user_focus","requestId":"focus-history:channel"}');
  assert.deepEqual(physical.sent, [
    '{"type":"human_connect","token":"scoped","requestId":"subscribe"}',
    '{"type":"user_focus","requestId":"focus-history:channel"}',
  ]);
  physical.receive('{"type":"presence","step":1}');
  physical.receive('{"type":"presence","step":2}');
  await settle();
  assert.equal(parts.received.length, 0);
  physical.receive('{"type":"message","step":3}');
  await settle();
  assert.deepEqual(parts.received[0].map((frame) => frame.value.step), [1, 2, 3]);
  physical.receive("pong");
  physical.receive('{"type":"channel_updated","step":4}');
  physical.drop(4401, "renew authentication");
  await settle();
  assert.deepEqual(parts.received[1], [{ kind: "raw", data: "pong" }]);
  assert.equal(parts.received[2][0].value.step, 4);
  assert.equal(parts.closes[0].code, 4401);
  assert.equal(parts.closes[0].reason, "renew authentication");
  assert.equal(worker.terminated, true);
  assert.equal(worker.sockets.length, 1);
});

test("unavailable Worker starts native only once and retains identical packet barriers", async (t) => {
  let attempts = 0;
  const parts = transport(t, { createWorker: () => { attempts += 1; throw new Error("CSP refusal"); } });
  t.mock.timers.tick(0);
  const physical = parts.native[0];
  physical.open();
  physical.receive('{"type":"presence","step":1}');
  physical.receive('{"type":"channel_updated","step":2}');
  assert.equal(parts.received.length, 0);
  t.mock.timers.tick(16);
  assert.deepEqual(parts.received[0].map((frame) => frame.value.step), [1, 2]);
  physical.receive('{"type":"presence","step":3}');
  physical.receive('{"type":"channel_history","requestId":"focus-history:channel"}');
  assert.equal(parts.received.length, 2);
  const next = parts.open("wss://hub.example/ws/humans");
  t.after(() => next.dispose());
  t.mock.timers.tick(0);
  assert.equal(attempts, 1, "one session does not repeatedly attempt blocked Workers");
  assert.equal(parts.native.length, 2);
});

test("Worker failure after physical dial closes the session before native redial", async (t) => {
  const parts = transport(t);
  const { worker } = await startWorker(t, parts);
  worker.crash();
  assert.equal(worker.terminated, true);
  assert.equal(parts.closes[0].code, 1006);
  assert.equal(parts.native.length, 0, "the connection owner must reauthenticate a new dial");
  const next = parts.open("wss://hub.example/ws/humans");
  t.after(() => next.dispose());
  t.mock.timers.tick(0);
  assert.equal(parts.native.length, 1);
  dispatch(worker, "message", { data: { type: "packet", frames: [{ kind: "json", value: { type: "message" } }] } });
  assert.equal(parts.received.length, 0, "a dead worker cannot leak old-session frames");
});

test("stopping during startup or with pending frames releases the worker and its tail", async (t) => {
  const parts = transport(t);
  const { worker, physical } = await startWorker(t, parts);
  physical.receive('{"type":"presence"}');
  parts.socket.dispose();
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(worker.terminated, true);
  assert.equal(parts.received.length, 0);
  assert.equal(parts.native.length, 0);
  const neverStarted = parts.open("wss://hub.example/ws/humans");
  neverStarted.dispose();
  t.mock.timers.tick(0);
  assert.equal(parts.workers.length, 1);
});

test("a Worker that never becomes ready times out before any physical dial", (t) => {
  const worker = Object.assign(new EventTarget(), {
    postMessage() { assert.fail("no command may precede ready"); },
    terminate() { this.terminated = true; },
  });
  const parts = transport(t, { createWorker: () => worker, startupTimeoutMs: 100 });
  t.mock.timers.tick(0);
  t.mock.timers.tick(100);
  assert.equal(worker.terminated, true);
  assert.equal(parts.native.length, 1);
});

test("a failed message-port send ends its dial and does not silently replace it", async (t) => {
  const parts = transport(t);
  const { worker } = await startWorker(t, parts);
  worker.postMessage = () => { throw new Error("dead port"); };
  parts.socket.send("fresh-token-authentication");
  assert.equal(parts.closes[0].code, 1006);
  assert.equal(worker.terminated, true);
  assert.equal(parts.native.length, 0);
});

test("native construction failure is observable after the owner attaches its handlers", (t) => {
  const parts = transport(t, {
    createWorker: () => { throw new Error("Worker unavailable"); },
    openNative: () => { throw new Error("invalid admitted URL"); },
  });
  t.mock.timers.tick(0);
  assert.equal(parts.closes[0].code, 1006);
  assert.equal(parts.socket.readyState, 3);
});

for (const mode of ["worker", "native"]) {
  test(`${mode} flushes received state before the owner's error policy can close it`, async (t) => {
    const parts = transport(t, mode === "native" ? {
      createWorker: () => { throw new Error("native fallback"); },
    } : {});
    let physical;
    if (mode === "worker") ({ physical } = await startWorker(t, parts));
    else {
      t.mock.timers.tick(0);
      physical = parts.native[0];
      physical.open();
    }
    let stateAtError;
    parts.socket.addEventListener("error", () => {
      stateAtError = parts.received.flat().map((frame) => frame.value.step);
      parts.socket.close();
    });
    physical.receive('{"type":"channel_updated","step":42}');
    dispatch(physical, "error");
    await settle();
    assert.deepEqual(stateAtError, [42]);
    assert.equal(parts.received.flat().length, 1);
    assert.equal(parts.socket.readyState, 3);
  });
}

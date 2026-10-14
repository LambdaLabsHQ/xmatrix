const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { ReconnectingSocket } = require("../../lib/connectivity/reconnecting-socket.ts");
const { createWorkerSocketOpener } = require("../../lib/connectivity/worker-socket-transport.ts");

test("Human packets finish before reconnect policy and cannot cross into the next dial", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const priorGlobals = new Map();
  const replacements = {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false }),
    navigator: { onLine: true },
    WebSocket: { CONNECTING: 0, OPEN: 1 },
    CloseEvent: class extends Event {
      constructor(type, options) { super(type); Object.assign(this, options); }
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    priorGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  let connection;
  t.after(() => {
    connection?.stop();
    for (const [name, descriptor] of priorGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  // Only the network is controlled. Packet timing, retirement, reconnection
  // and close-policy sequencing run through the real transport and owner.
  const physical = [];
  const opener = createWorkerSocketOpener({
    createWorker() { throw new Error("Worker blocked by this client"); },
    openNative() {
      const socket = Object.assign(new EventTarget(), {
        readyState: 0,
        sent: [],
        open() { this.readyState = 1; this.dispatchEvent(new Event("open")); },
        receive(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); },
        send(value) { this.sent.push(value); },
        close(code = 1000) {
          this.readyState = 3;
          this.dispatchEvent(new CloseEvent("close", { code, reason: "", wasClean: code === 1000 }));
        },
      });
      physical.push(socket);
      return socket;
    },
  });
  const calls = [];
  let allowRetry;
  const closePolicy = new Promise((resolve) => { allowRetry = resolve; });
  connection = new ReconnectingSocket({
    open: async () => opener("wss://hub.example/ws/humans"),
    onPacket: (_socket, frames) => calls.push(frames.map(frame => frame.value.step)),
    onDown: () => calls.push("down"),
    onClose: (event) => { calls.push(event.code); return closePolicy; },
    backoff: { baseMs: 1, maxMs: 1 },
    random: () => 1,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  connection.start();
  await settle();
  t.mock.timers.tick(0);
  physical[0].open();

  physical[0].receive({ type: "channel_updated", step: 42 });
  assert.deepEqual(calls, [], "state is waiting in the transport packet");
  physical[0].close(4401);
  assert.deepEqual(calls, [[42], "down", 4401], "good state precedes the physical close and its policy");
  physical[0].receive({ type: "presence", step: -1 });
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(physical.length, 1, "backoff cannot bypass the pending close policy");

  allowRetry("reconnect");
  await settle();
  t.mock.timers.tick(1);
  await settle();
  t.mock.timers.tick(0);
  assert.equal(physical.length, 2);
  physical[1].open();
  physical[1].receive({ type: "presence", step: 43 });
  physical[0].receive({ type: "channel_updated", step: -2 });
  physical[1].receive({ type: "channel_updated", step: 44 });
  t.mock.timers.tick(16);
  assert.deepEqual(calls, [[42], "down", 4401, [43, 44]]);
  connection.current.send("current-dial-only");
  assert.deepEqual(physical.map(socket => socket.sent), [[], ["current-dial-only"]]);

  physical[1].receive({ type: "presence", step: 45 });
  connection.stop();
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(calls, [[42], "down", 4401, [43, 44], "down"]);
  assert.equal(physical.length, 2, "stopping cancels reconnect and pending packet timers");
  assert.equal(physical[1].readyState, 3);
});

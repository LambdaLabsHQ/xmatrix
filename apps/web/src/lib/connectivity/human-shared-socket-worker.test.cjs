const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { HUMAN_CLIENT_BROWSER_READ, HUMAN_HEARTBEAT_PING } = require("@xmatrix/protocol");
const { installHumanSharedSocketWorker } = require("./human-shared-socket-worker.ts");
const {
  createSharedWorkerSocketOpener,
  isSharedHumanSocketEnabled,
  SHARED_SOCKET_DISABLE_STORAGE_KEY,
} = require("./shared-worker-socket-transport.ts");

function createFakeSocket(url) {
  const listeners = new Map();
  const sent = [];
  const socket = {
    url,
    readyState: 0,
    sent,
    closeCalls: [],
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    send(data) {
      sent.push(data);
    },
    close(code = 1000, reason = "") {
      this.closeCalls.push({ code, reason });
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", { code, reason, wasClean: true });
    },
    openNow() {
      this.readyState = 1;
      this.emit("open", {});
    },
    receive(payload) {
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.emit("message", { data });
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return socket;
}

function createFakePortPair() {
  const serverListeners = new Set();
  const clientListeners = new Set();
  const receivedByClient = [];
  const serverPort = {
    start() {},
    close() {},
    addEventListener(type, listener) {
      if (type === "message") serverListeners.add(listener);
    },
    postMessage(data) {
      receivedByClient.push(data);
      for (const listener of clientListeners) listener({ data });
    },
  };
  const clientPort = {
    received: receivedByClient,
    start() {},
    close() {},
    addEventListener(type, listener) {
      if (type === "message") clientListeners.add(listener);
    },
    postMessage(data) {
      for (const listener of serverListeners) listener({ data });
    },
  };
  return { serverPort, clientPort };
}

function createSharedHarness(options = {}) {
  const connectListeners = new Set();
  const sockets = [];
  let timers = [];
  let intervals = [];
  let nowMs = 10_000;
  const scope = {
    addEventListener(type, listener) {
      if (type === "connect") connectListeners.add(listener);
    },
  };
  const worker = installHumanSharedSocketWorker(scope, {
    open(url) {
      const s = createFakeSocket(url);
      sockets.push(s);
      return s;
    },
    idleKeepAliveMs: options.idleKeepAliveMs ?? 30_000,
    portLivenessIntervalMs: options.portLivenessIntervalMs ?? 15_000,
    requestTtlMs: options.requestTtlMs ?? 60_000,
    now: () => nowMs,
    setTimer(cb, ms) {
      const handle = { cb, at: nowMs + ms, active: true };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) handle.active = false;
    },
    setIntervalFn(cb, ms) {
      const handle = { cb, ms, active: true };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      if (handle) handle.active = false;
    },
  });
  function connectPort() {
    const pair = createFakePortPair();
    for (const listener of connectListeners) listener({ ports: [pair.serverPort] });
    return pair.clientPort;
  }
  function advance(ms) {
    nowMs += ms;
    const due = timers.filter((t) => t.active && t.at <= nowMs);
    timers = timers.filter((t) => t.active && t.at > nowMs);
    for (const t of due) {
      if (t.active) t.cb();
    }
  }
  function tickLiveness() {
    for (const interval of intervals) {
      if (interval.active) interval.cb();
    }
  }
  return { worker, sockets, connectPort, advance, tickLiveness };
}

test("same-channel views share one socket, swallow duplicate human_connect, and route multi-frame requestId replies only to caller", () => {
  const h = createSharedHarness();
  const card = h.connectPort();
  const panel = h.connectPort();

  card.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "inline" });
  assert.equal(h.sockets.length, 1);
  h.sockets[0].openNow();

  card.postMessage({
    type: "send",
    data: JSON.stringify({
      type: "human_connect",
      token: "tok-1",
      requestId: "card-auth",
      device: { capabilities: [HUMAN_CLIENT_BROWSER_READ] },
    }),
  });
  const authFrame = JSON.parse(h.sockets[0].sent[0]);
  h.sockets[0].receive({ type: "human_connected", requestId: authFrame.requestId, user: { id: "u1" } });
  h.sockets[0].receive({ type: "agent_list", requestId: authFrame.requestId, agents: [] });

  panel.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "panel" });
  assert.equal(h.sockets.length, 1);
  panel.postMessage({
    type: "send",
    data: JSON.stringify({
      type: "human_connect",
      token: "tok-1",
      requestId: "panel-auth",
      device: { capabilities: [HUMAN_CLIENT_BROWSER_READ] },
    }),
  });
  assert.equal(h.sockets[0].sent.length, 1, "duplicate human_connect must be swallowed");

  // Multi-frame reply for one requestId: BOTH frames route ONLY to panel with restored requestId.
  const cardBefore = card.received.length;
  panel.postMessage({
    type: "send",
    data: JSON.stringify({ type: "user_focus_channel", requestId: "focus-history:ch-1", channelId: "ch-1" }),
  });
  const sentFocus = JSON.parse(h.sockets[0].sent[1]);
  h.sockets[0].receive({ type: "channel_history", requestId: sentFocus.requestId, channelId: "ch-1", messages: [{ messageId: "m1" }] });
  h.sockets[0].receive({ type: "channel_history_tail", requestId: sentFocus.requestId, channelId: "ch-1", extra: true });

  assert.equal(card.received.length, cardBefore, "card never receives any frame of panel's requestId");
  const panelReplies = panel.received.slice(-2).map((e) => e.frames[0].value);
  assert.equal(panelReplies[0].type, "channel_history");
  assert.equal(panelReplies[0].requestId, "focus-history:ch-1");
  assert.equal(panelReplies[1].type, "channel_history_tail");
  assert.equal(panelReplies[1].requestId, "focus-history:ch-1");

  h.worker.dispose();
});

test("pool is strictly partitioned by userId and clear-user immediately drops all connections on sign-out", () => {
  const h = createSharedHarness({ idleKeepAliveMs: 30_000 });
  const u1Port = h.connectPort();
  u1Port.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "panel" });
  h.sockets[0].openNow();
  u1Port.postMessage({ type: "send", data: JSON.stringify({ type: "human_connect", token: "tok-u1", requestId: "r1" }) });
  const auth1 = JSON.parse(h.sockets[0].sent[0]).requestId;
  h.sockets[0].receive({ type: "human_connected", requestId: auth1, user: { id: "u1" } });
  u1Port.postMessage({ type: "dispose" });
  assert.equal(h.sockets[0].readyState, 1, "u1 socket is hot within 30s");

  // User u2 opens the same channel within 30s -> MUST get its own separate connection, never u1's!
  const u2Port = h.connectPort();
  u2Port.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u2", focusKey: "ch-1", clientRole: "panel" });
  assert.equal(h.sockets.length, 2, "different userId never shares u1's hot socket");

  // clear-user for u1 closes u1's hot socket immediately without touching u2.
  const control = h.connectPort();
  control.postMessage({ type: "clear-user", userId: "u1" });
  assert.equal(h.sockets[0].readyState, 3, "u1 socket closed immediately on sign-out");
  assert.equal(h.sockets[1].readyState, 0, "u2 socket unaffected");

  h.worker.dispose();
});

test("every connection keeps browser_read capability and deduplicates browser_read_requested across connections", () => {
  const h = createSharedHarness();
  const c1 = h.connectPort();
  const c2 = h.connectPort();

  c1.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "inline" });
  h.sockets[0].openNow();
  c1.postMessage({
    type: "send",
    data: JSON.stringify({ type: "human_connect", token: "t", requestId: "a1", device: { capabilities: [HUMAN_CLIENT_BROWSER_READ] } }),
  });
  const auth1 = JSON.parse(h.sockets[0].sent[0]);
  assert.ok(auth1.device.capabilities.includes(HUMAN_CLIENT_BROWSER_READ));
  h.sockets[0].receive({ type: "human_connected", requestId: auth1.requestId, user: { id: "u1" } });

  c2.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-2", clientRole: "panel" });
  h.sockets[1].openNow();
  c2.postMessage({
    type: "send",
    data: JSON.stringify({ type: "human_connect", token: "t", requestId: "a2", device: { capabilities: [HUMAN_CLIENT_BROWSER_READ] } }),
  });
  const auth2 = JSON.parse(h.sockets[1].sent[0]);
  assert.ok(auth2.device.capabilities.includes(HUMAN_CLIENT_BROWSER_READ), "second connection also declares browser_read");
  h.sockets[1].receive({ type: "human_connected", requestId: auth2.requestId, user: { id: "u1" } });

  // Hub sends the same browser_read_requested on BOTH sockets -> delivered ONLY ONCE total!
  const beforeC1 = c1.received.length;
  const beforeC2 = c2.received.length;
  h.sockets[0].receive({ type: "browser_read_requested", requestId: "br-dup", target: "current" });
  h.sockets[1].receive({ type: "browser_read_requested", requestId: "br-dup", target: "current" });
  const totalDelivered = (c1.received.length - beforeC1) + (c2.received.length - beforeC2);
  assert.equal(totalDelivered, 1, "browser_read_requested is deduplicated across connections");

  // Even after socket 0 closes, socket 1 still serves future browser_read_requested!
  h.sockets[0].close(1000, "gone");
  const beforeSecond = c2.received.length;
  h.sockets[1].receive({ type: "browser_read_requested", requestId: "br-after-close", target: "current" });
  assert.equal(c2.received.length, beforeSecond + 1, "remaining connection still handles browser_read");

  h.worker.dispose();
});

test("liveness timeout sends close event to frozen port so it reconnects on wake", () => {
  const h = createSharedHarness();
  const frozen = h.connectPort();
  frozen.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "inline" });
  h.sockets[0].openNow();

  // Miss 2 port-pings, then 3rd sweep evicts AND notifies close.
  h.tickLiveness();
  assert.equal(frozen.received.at(-1).type, "port-ping");
  h.tickLiveness();
  h.tickLiveness();
  const closeEvent = frozen.received.find((e) => e.type === "close");
  assert.ok(closeEvent, "evicted frozen port must receive close notification to trigger reconnect");
  assert.equal(closeEvent.code, 4001);

  h.worker.dispose();
});

test("focus switch to a new channel authenticates silently without emitting a second human_connected, and empty default entries do not linger", () => {
  const h = createSharedHarness({ idleKeepAliveMs: 30_000 });
  const p1 = h.connectPort();
  const p2 = h.connectPort();

  // Both start on default key (shared 1 socket).
  p1.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: null, clientRole: "inline" });
  p2.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: null, clientRole: "panel" });
  assert.equal(h.sockets.length, 1);
  h.sockets[0].openNow();
  p1.postMessage({ type: "send", data: JSON.stringify({ type: "human_connect", token: "t", requestId: "r1" }) });
  p2.postMessage({ type: "send", data: JSON.stringify({ type: "human_connect", token: "t", requestId: "r2" }) });
  const auth0 = JSON.parse(h.sockets[0].sent[0]).requestId;
  h.sockets[0].receive({ type: "human_connected", requestId: auth0, user: { id: "u1" } });
  h.sockets[0].receive({ type: "agent_list", requestId: auth0, agents: [] });

  const countConnected = (port) => port.received
    .filter((e) => e.type === "packet")
    .flatMap((e) => e.frames)
    .filter((f) => f.value?.type === "human_connected").length;
  assert.equal(countConnected(p1), 1);

  // p1 focuses ch-1 (moves to new socket because p2 is still on default).
  p1.postMessage({
    type: "send",
    data: JSON.stringify({ type: "user_focus_channel", requestId: "f1", channelId: "ch-1" }),
  });
  assert.equal(h.sockets.length, 2);
  h.sockets[1].openNow();
  const auth1 = JSON.parse(h.sockets[1].sent[0]).requestId;
  h.sockets[1].receive({ type: "human_connected", requestId: auth1, user: { id: "u1" } });
  h.sockets[1].receive({ type: "agent_list", requestId: auth1, agents: [] });

  // p1 MUST NOT receive a second human_connected, AND its queued user_focus_channel flushed!
  assert.equal(countConnected(p1), 1, "no duplicate human_connected on focus switch");
  assert.equal(JSON.parse(h.sockets[1].sent[1]).type, "user_focus_channel");

  // p2 leaves default -> unfocused default entry closes immediately (does NOT linger 30s).
  p2.postMessage({ type: "dispose" });
  assert.equal(h.sockets[0].readyState, 3, "empty default entry closes immediately without 30s linger");

  h.worker.dispose();
});

test("real periodic HUMAN_HEARTBEAT_PING is sent to Hub even during busy incoming traffic", () => {
  const h = createSharedHarness();
  const p1 = h.connectPort();
  const p2 = h.connectPort();
  p1.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "inline" });
  p2.postMessage({ type: "connect", url: "wss://hub.example/ws/humans", userId: "u1", focusKey: "ch-1", clientRole: "panel" });
  h.sockets[0].openNow();

  // Busy traffic arrives right before ping.
  h.sockets[0].receive({ type: "channel_message_received", message: { messageId: "m1", channelId: "ch-1", body: "busy" } });
  p1.postMessage({ type: "send", data: HUMAN_HEARTBEAT_PING });
  p2.postMessage({ type: "send", data: HUMAN_HEARTBEAT_PING });

  // Concurrent pings coalesce to 1 REAL physical ping to Hub (never suppressed by message traffic).
  assert.equal(h.sockets[0].sent.filter((s) => s === HUMAN_HEARTBEAT_PING).length, 1);
  h.sockets[0].receive({ type: "pong", requestId: "web-heartbeat" });

  // 25s later (even with more busy traffic), another real ping goes to Hub.
  h.advance(25_000);
  h.sockets[0].receive({ type: "channel_message_received", message: { messageId: "m2", channelId: "ch-1", body: "still busy" } });
  p1.postMessage({ type: "send", data: HUMAN_HEARTBEAT_PING });
  assert.equal(h.sockets[0].sent.filter((s) => s === HUMAN_HEARTBEAT_PING).length, 2);

  h.worker.dispose();
});

test("feature switch stays off outside extension and SharedWorker startup failure falls back cleanly", async () => {
  assert.equal(isSharedHumanSocketEnabled(false), false, "always disabled on Web/Desktop/Mobile");

  const prevSW = globalThis.SharedWorker;
  const prevWin = globalThis.window;
  globalThis.SharedWorker = function FakeSW() {};
  const storage = new Map();
  globalThis.window = { localStorage: { getItem: (k) => storage.get(k) ?? null } };
  try {
    assert.equal(isSharedHumanSocketEnabled(true), true);
    storage.set(SHARED_SOCKET_DISABLE_STORAGE_KEY, "1");
    assert.equal(isSharedHumanSocketEnabled(true), false, "localStorage switch disables SharedWorker");
    storage.delete(SHARED_SOCKET_DISABLE_STORAGE_KEY);
    globalThis.__xmatrixDisableSharedSocket = true;
    assert.equal(isSharedHumanSocketEnabled(true), false, "global flag disables SharedWorker");
  } finally {
    delete globalThis.__xmatrixDisableSharedSocket;
    globalThis.SharedWorker = prevSW;
    globalThis.window = prevWin;
  }

  let fallbackCalls = 0;
  const fallbackSocket = createFakeSocket("wss://hub.example/ws/humans");
  fallbackSocket.subscribePackets = () => () => {};
  const opener = createSharedWorkerSocketOpener({
    createSharedWorker() { throw new Error("CSP blocked"); },
    fallbackOpener() {
      fallbackCalls += 1;
      setTimeout(() => fallbackSocket.openNow(), 0);
      return fallbackSocket;
    },
    userId: "u1",
  });
  const transport = opener("wss://hub.example/ws/humans");
  await new Promise((resolve) => {
    transport.addEventListener("open", resolve, { once: true });
  });
  assert.equal(fallbackCalls, 1, "falls back seamlessly when SharedWorker fails");
  transport.dispose();

  // Worker error event falls back immediately instead of waiting out the 3s startup timeout.
  let fastFallbackCalls = 0;
  const fastSocket = createFakeSocket("wss://hub.example/ws/humans");
  fastSocket.subscribePackets = () => () => {};
  const errorListeners = [];
  const failingWorker = {
    port: { start() {}, close() {}, addEventListener() {}, postMessage() {} },
    addEventListener(type, listener) {
      if (type === "error") errorListeners.push(listener);
    },
  };
  const startedAt = Date.now();
  const fastOpener = createSharedWorkerSocketOpener({
    createSharedWorker: () => {
      setTimeout(() => {
        for (const listener of errorListeners) listener(new Event("error"));
      }, 0);
      return failingWorker;
    },
    fallbackOpener() {
      fastFallbackCalls += 1;
      setTimeout(() => fastSocket.openNow(), 0);
      return fastSocket;
    },
    userId: "u1",
    startupTimeoutMs: 3_000,
  });
  const fastTransport = fastOpener("wss://hub.example/ws/humans");
  await new Promise((resolve) => {
    fastTransport.addEventListener("open", resolve, { once: true });
  });
  assert.equal(fastFallbackCalls, 1, "falls back immediately when SharedWorker fires an error event");
  assert.ok(Date.now() - startedAt < 500, "must not wait out the 3s startup timeout");
  fastTransport.dispose();
});

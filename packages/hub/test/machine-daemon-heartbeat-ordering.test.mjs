import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FakeSocket,
  machineDaemonConnectFrame,
  machineDaemonTransport,
  socketFrame as frame,
} from "./support/runtime-transport.mjs";

const principal = {
  ownerUserId: "heartbeat-owner",
  ownerEmail: "owner@example.test",
  machineId: "heartbeat-machine",
  hostId: "heartbeat-host",
};
const connect = () => machineDaemonConnectFrame(principal);
const transport = (overrides) => machineDaemonTransport(principal, overrides);

test("daemon heartbeat answers while authenticated connect catches up commands", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const runtime = transport({
    async connected() { started.resolve(); await release.promise; },
  });
  const socket = new FakeSocket();
  runtime.accept(socket);
  const connecting = runtime.handleFrame(socket, connect());
  await started.promise;
  let ping;
  try {
    assert.equal(socket.sent.at(-1).type, "machine_daemon_connected");
    ping = runtime.handleFrame(socket, frame("ping", { requestId: "catch-up-probe" }));
    assert.equal(socket.sent.at(-1).type, "pong");
    assert.equal(socket.sent.at(-1).requestId, "catch-up-probe");
    assert.equal(runtime.isRouteReachable(principal), true);
  } finally {
    release.resolve();
    await connecting;
    await ping;
  }
});

test("heartbeat bypasses slow authority work while control messages stay ordered", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const executed = [];
  const runtime = transport({
    async execute(_session, message) {
      executed.push(message.type);
      if (message.type === "machine_run_snapshot") {
        started.resolve();
        await release.promise;
      }
    },
  });
  const socket = new FakeSocket();
  runtime.accept(socket);
  await runtime.handleFrame(socket, connect());
  const snapshot = runtime.handleFrame(socket, frame("machine_run_snapshot", { runs: [] }));
  await started.promise;
  const control = runtime.handleFrame(socket, frame("machine_command_admitted", { requestId: "admit" }));
  let ping;
  try {
    ping = runtime.handleFrame(socket, frame("ping", { requestId: "busy-probe" }));
    assert.equal(socket.sent.at(-1).type, "pong");
    assert.equal(socket.sent.at(-1).requestId, "busy-probe");
    assert.deepEqual(executed, ["machine_run_snapshot"]);
  } finally {
    release.resolve();
    await Promise.all([snapshot, control, ping]);
  }
  assert.deepEqual(executed, ["machine_run_snapshot", "machine_command_admitted"]);
});

test("unauthenticated and disconnected sockets cannot use the heartbeat fast path", async () => {
  const runtime = transport();
  const socket = new FakeSocket();
  runtime.accept(socket);
  await runtime.handleFrame(socket, frame("ping", { requestId: "before-connect" }));
  assert.equal(socket.sent.at(-1).type, "error");
  assert.match(socket.sent.at(-1).message, /authenticate/u);
  const connected = new FakeSocket();
  runtime.accept(connected);
  await runtime.handleFrame(connected, connect());
  await runtime.handleClose(connected, 1000, "closed", true);
  await runtime.handleFrame(connected, frame("ping", { requestId: "after-close" }));
  assert.equal(connected.sent.at(-1).type, "error");
  assert.match(connected.sent.at(-1).message, /authenticate/u);
  assert.equal(runtime.isRouteReachable(principal), false);
});

test("a probe that wakes the Runtime checks the catalog once per interval, across hibernation", async () => {
  const confirmed = [];
  const backend = { async confirmOnline(session) { confirmed.push(session.connectionEpoch); } };
  const awake = transport(backend);
  const socket = new FakeSocket();
  awake.accept(socket);
  await awake.handleFrame(socket, connect());
  await awake.handleFrame(socket, frame("ping", { requestId: "probe-1" }));
  await awake.handleFrame(socket, frame("ping", { requestId: "probe-2" }));
  assert.deepEqual(confirmed, [1]);

  // Every probe wakes a hibernated object into a fresh transport; the check it
  // already made rides the socket's attachment instead of being repeated.
  const woken = transport(backend);
  assert.equal(woken.rehydrate(socket, awake.hibernationAttachment(socket)), true);
  await woken.handleFrame(socket, frame("ping", { requestId: "probe-3" }));
  assert.deepEqual(confirmed, [1]);
  assert.equal(socket.sent.at(-1).type, "pong");
});

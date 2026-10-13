import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MachineDaemonRuntimeTransport,
  MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/machine-daemon-port.ts";
import { FakeSocket } from "./support/runtime-transport.mjs";

const principal = {
  ownerUserId: "heartbeat-owner",
  ownerEmail: "owner@example.test",
  machineId: "heartbeat-machine",
  hostId: "heartbeat-host",
};
const frame = (type, fields = {}) => JSON.stringify({ type, ...fields });
const connect = () => frame("machine_daemon_connect", {
  requestId: "connect", token: "test-token", displayName: "Laptop",
  machineId: principal.machineId, hostId: principal.hostId,
  clientVersion: "1.0.350", protocolVersion: 2,
});

function transport(overrides = {}) {
  return new MachineDaemonRuntimeTransport({
    capabilities: new Set(MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() {
      return {
        principal,
        connected: {
          type: "machine_daemon_connected", connectionEpoch: 1,
          daemon: {
            id: "heartbeat-daemon", userId: principal.ownerUserId,
            email: principal.ownerEmail, machineId: principal.machineId,
          },
        },
      };
    },
    async refresh() { return principal; },
    async execute() {},
    async disconnected() {},
    ...overrides,
  });
}

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

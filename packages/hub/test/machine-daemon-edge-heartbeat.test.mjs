import assert from "node:assert/strict";
import { test } from "node:test";

import { CLIENT_UPGRADE_REQUIRED_CLOSE_CODE } from "@xmatrix/protocol";
import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import { AttachedSocket } from "./support/runtime-transport.mjs";

// A daemon's liveness is read from the platform's timestamp of its last
// auto-answered edge heartbeat, settled by whatever event wakes the cell.
// Nothing here runs on a timer, and an idle daemon never wakes the Runtime.

const route = Object.freeze({ ownerUserId: "owner-1", machineId: "machine-1", hostId: "host-1" });
const principal = Object.freeze({ ...route, ownerEmail: "owner@example.test" });
const NOW = Date.parse("2026-11-06T08:00:00.000Z");

function attachment({ connectedAt = new Date(NOW - 10 * 60_000).toISOString(), capabilities } = {}) {
  return {
    version: 1,
    domain: "machine_daemon",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    session: {
      principal,
      connectionEpoch: 3,
      displayName: "Workstation",
      clientVersion: "0.16.698",
      clientProtocolVersion: 2,
      capabilities: capabilities ?? [machine.MACHINE_DAEMON_EDGE_HEARTBEAT_CAPABILITY],
      machineMetadata: {},
      connectedAt,
      lastSeenAt: connectedAt,
    },
  };
}

function transport() {
  const disconnects = [];
  const port = new machine.MachineDaemonRuntimeTransport({
    capabilities: new Set(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() { throw new Error("unexpected authenticate"); },
    async refresh() { throw new Error("unexpected refresh"); },
    async execute() { throw new Error("unexpected execute"); },
    async disconnected(_session, details) { disconnects.push(details.code); },
  });
  return { port, disconnects };
}

test("the edge heartbeat cadence allows three misses", () => {
  assert.equal(machine.MACHINE_DAEMON_EDGE_HEARTBEAT_MS, 15_000);
  assert.equal(machine.MACHINE_DAEMON_EDGE_SILENCE_MS, 45_000);
});

test("a daemon whose edge heartbeat went silent is closed and persisted offline", () => {
  const { port, disconnects } = transport();
  const socket = new AttachedSocket();
  assert.equal(port.rehydrate(socket, attachment()), true);

  const evicted = port.evictSilent(() => new Date(NOW - 46_000), { now: NOW });

  assert.equal(evicted, 1);
  assert.equal(port.isRouteReachable(route), false);
  assert.deepEqual(socket.closed.map(({ code }) => code), [machine.MACHINE_DAEMON_ROUTE_CLOSE.silentHeartbeat.code]);
  assert.deepEqual(disconnects, [machine.MACHINE_DAEMON_ROUTE_CLOSE.silentHeartbeat.code]);
});

test("a heartbeat answered within the window keeps the daemon", () => {
  const { port, disconnects } = transport();
  const socket = new AttachedSocket();
  port.rehydrate(socket, attachment());

  assert.equal(port.evictSilent(() => new Date(NOW - 44_000), { now: NOW }), 0);
  assert.equal(port.isRouteReachable(route), true);
  assert.deepEqual(socket.closed, []);
  assert.deepEqual(disconnects, []);
});

test("a fresh connection that has not been answered yet counts from its connect", () => {
  const { port } = transport();
  const socket = new AttachedSocket();
  port.rehydrate(socket, attachment({ connectedAt: new Date(NOW - 5_000).toISOString() }));
  assert.equal(port.evictSilent(() => null, { now: NOW }), 0);
  assert.equal(port.evictSilent(() => null, { now: NOW + 41_000 }), 1);
});

test("the socket whose own frame woke the cell is not judged silent", () => {
  const { port } = transport();
  const socket = new AttachedSocket();
  port.rehydrate(socket, attachment());
  assert.equal(port.evictSilent(() => null, { now: NOW, except: socket }), 0);
  assert.equal(port.isRouteReachable(route), true);
});

test("a daemon without the edge heartbeat is never judged by its silence", () => {
  const { port } = transport();
  const socket = new AttachedSocket();
  port.rehydrate(socket, attachment({ capabilities: ["machine_command_admission_ack_v1"] }));
  assert.equal(port.evictSilent(() => null, { now: NOW }), 0);
  assert.equal(port.isRouteReachable(route), true);
});

test("no daemon route close tells a daemon to stop reconnecting", () => {
  // 4003 makes the CLI give up until it is updated; a failed delivery or a
  // silent heartbeat must only make it reconnect.
  for (const close of Object.values(machine.MACHINE_DAEMON_ROUTE_CLOSE)) {
    assert.notEqual(close.code, CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, close.reason);
  }
  assert.equal(
    machine.shouldPersistMachineDaemonOfflineAfterEvict(machine.MACHINE_DAEMON_ROUTE_CLOSE.silentHeartbeat, 0),
    true,
  );
});

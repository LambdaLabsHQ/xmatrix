import assert from "node:assert/strict";
import { test } from "node:test";

import { ControlError } from "@xmatrix/db";

import { MACHINE_DAEMON_ROUTE_CLOSE } from "../src/runtime-transport/machine-daemon-port.ts";
import { capturingConsole } from "./support/capturing-console.mjs";
import {
  FakeSocket,
  machineDaemonConnectFrame,
  machineDaemonTransport,
  socketFrame as frame,
} from "./support/runtime-transport.mjs";

const principal = {
  ownerUserId: "superseded-owner",
  ownerEmail: "owner@example.test",
  machineId: "superseded-machine",
  hostId: "superseded-host",
};

async function reportOnConnection(execute, disconnected) {
  const runtime = machineDaemonTransport(principal, { execute, ...disconnected && { disconnected } }, 7);
  const socket = new FakeSocket();
  runtime.accept(socket);
  await runtime.handleFrame(socket, machineDaemonConnectFrame(principal));
  const logged = await capturingConsole(() =>
    runtime.handleFrame(socket, frame("machine_run_snapshot", { requestId: "report", runs: [] })));
  return { runtime, socket, logged };
}

test("a frame fenced by a newer connect of the same daemon is not a Hub error and closes its connection (XMATRIX-HUB-7S)", async () => {
  const offline = [];
  const { runtime, socket, logged } = await reportOnConnection(async () => {
    throw new ControlError("machine_daemon_stale_epoch", 409, "Machine Daemon process was replaced by a newer connection");
  }, async (_session, details) => { offline.push(details); });

  assert.deepEqual(logged.error, []);
  assert.deepEqual(logged.warn.map(([message, detail]) => [message, detail.authorityCode]),
    [["xMatrix runtime authority rejection", "machine_daemon_stale_epoch"]]);
  const answer = socket.sent.at(-1);
  assert.equal(answer.requestId, "report");
  assert.equal(answer.failure.code, "machine_daemon_stale_epoch");
  assert.equal(answer.failure.retryable, false);
  // Closed as replaced, never written offline: the newer connection owns the route.
  assert.deepEqual(socket.closed, [MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect]);
  assert.deepEqual(offline, []);
  assert.equal(runtime.isRouteReachable(principal), false);
});

test("any other rejection of a daemon frame stays a reported error on a connection that stays open", async () => {
  const { runtime, socket, logged } = await reportOnConnection(async () => {
    throw new ControlError("machine_daemon_not_registered", 409, "Machine Daemon must connect before this operation");
  });

  assert.deepEqual(logged.error.map(([message, detail]) => [message, detail.authorityCode]),
    [["xMatrix runtime authority rejection", "machine_daemon_not_registered"]]);
  assert.equal(socket.sent.at(-1).failure.code, "runtime.authority_rejected");
  assert.deepEqual(socket.closed, []);
  assert.equal(runtime.isRouteReachable(principal), true);
});

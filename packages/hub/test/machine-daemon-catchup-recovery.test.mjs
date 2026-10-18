import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlError } from "@xmatrix/db";
import { MachineDaemonRuntimeTransport, MACHINE_DAEMON_ROUTE_CLOSE } from "../src/runtime-transport/machine-daemon-port.ts";
import { authorityPort, recordingCommands } from "./support/machine-daemon-port.mjs";
import { FakeSocket, machineDaemonConnectFrame } from "./support/runtime-transport.mjs";
import { capturingConsole } from "./support/capturing-console.mjs";

const principal = { ownerUserId: "catchup-owner", ownerEmail: "owner@example.test",
  machineId: "catchup-machine", hostId: "catchup-host" };
const lease = { leaseOwner: "lease-owner", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 7 };
const commands = ["stop-1", "stop-2", "stop-3"].map(requestId => ({ ...lease,
  payload: { type: "machine_stop_agent", requestId, runId: "run-1" } }));

// Existing owner tests covered an empty connect claim, not losing the socket
// while that claim awaits Authority. Exercise the real batch and transport.
function fixture(claim, retryError) {
  let epoch = 6;
  const calls = [], offline = [];
  const port = authorityPort({
    async authenticate() { return principal; },
    commands: recordingCommands(calls, async (_name, input) => {
      if (input.action === "connect") return { connectionEpoch: ++epoch, daemon: {
        id: "daemon-1", userId: principal.ownerUserId, email: principal.ownerEmail,
        machineId: principal.machineId, name: "Machine", status: "online", capabilities: [], metadata: {},
        createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z",
        lastSeenAt: "2026-10-18T00:00:00.000Z" } };
      if (input.action === "claim") return claim();
      if (input.action === "retry" && retryError) throw retryError;
      if (input.action === "unregister") offline.push(input.connectionEpoch);
      return {};
    }),
  });
  return { runtime: new MachineDaemonRuntimeTransport(port), calls, offline };
}

for (const loss of ["closed", "replaced"]) {
  test(`catch-up ${loss} during claim attempts to release every unsent lease without writing to its old socket (XMATRIX-HUB-8M)`, async () => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let claims = 0;
    const { runtime, calls, offline } = fixture(async () => {
      if (++claims !== 1) return { commands: [] };
      entered.resolve();
      return finish.promise;
    }, loss === "replaced" ? new ControlError("machine_daemon_stale_epoch", 409, "Replaced") : undefined);
    const old = new FakeSocket();
    runtime.accept(old);
    let newer;
    const logged = await capturingConsole(async () => {
      const connecting = runtime.handleFrame(old, machineDaemonConnectFrame(principal));
      await entered.promise;
      if (loss === "closed") old.readyState = 3;
      else {
        newer = new FakeSocket();
        runtime.accept(newer);
        await runtime.handleFrame(newer, machineDaemonConnectFrame(principal));
      }
      finish.resolve({ commands });
      await connecting;
    });
    assert.deepEqual(calls.filter(call => call.input.action === "retry").map(call =>
      [call.input.controlId, call.input.relayLease]), commands.map(command => [command.payload.requestId, lease]));
    assert.deepEqual(old.sent.map(message => message.type), ["machine_daemon_connected"]);
    assert.deepEqual(logged.error, []);
    assert.equal(runtime.session(old), undefined);
    assert.equal(runtime.isRouteReachable(principal), loss === "replaced");
    assert.deepEqual(offline, loss === "closed" ? [7] : []);
    assert.deepEqual(old.closed, [loss === "closed" ? MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver
      : MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect]);
    if (newer) {
      assert.deepEqual(newer.closed, []);
      assert.ok(runtime.session(newer));
    }
  });
}

test("batch send failure releases failed and later leases, preserves sent leases and the original failure", async () => {
  const calls = [];
  const port = authorityPort({ commands: recordingCommands(calls, (_name, input) =>
    input.action === "claim" ? { commands } : {}) });
  const session = { principal, connectionEpoch: 7, capabilities: [] };
  const failure = new Error("send failed");
  const sent = [];
  await assert.rejects(port.deliverPendingOnce(session, async command => {
    if (command.requestId === "stop-2") throw failure;
    sent.push(command.requestId);
  }), error => error === failure);
  assert.deepEqual(sent, ["stop-1"]);
  assert.deepEqual(calls.filter(call => call.input.action === "retry").map(call => call.input.controlId),
    ["stop-2", "stop-3"]);
});

test("an unrelated catch-up failure is still reported and leaves the live route intact", async () => {
  const { runtime } = fixture(async () => { throw new Error("authority failed"); });
  const socket = new FakeSocket();
  runtime.accept(socket);
  const logged = await capturingConsole(() => runtime.handleFrame(socket, machineDaemonConnectFrame(principal)));
  assert.equal(socket.sent.at(-1).type, "error");
  assert.equal(socket.sent.at(-1).failure.code, "runtime.session_failed");
  assert.equal(logged.error.length, 1);
  assert.equal(runtime.isRouteReachable(principal), true);
});

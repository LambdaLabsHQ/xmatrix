import assert from "node:assert/strict";
import { test } from "node:test";

import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import { FakeSocket } from "./support/runtime-transport.mjs";

const principal = Object.freeze({
  ownerUserId: "user-1",
  ownerEmail: "owner@example.test",
  machineId: "machine-1",
  hostId: "host-1",
});

function daemon() {
  return {
    id: "daemon-1",
    userId: principal.ownerUserId,
    email: principal.ownerEmail,
    machineId: principal.machineId,
    hostId: principal.hostId,
    name: "Workstation",
    status: "online",
    capabilities: [],
    metadata: {},
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    lastSeenAt: "2026-08-30T00:00:00.000Z",
  };
}

function connectFrame(requestId, activation) {
  return {
    type: "machine_daemon_connect",
    requestId,
    token: "test-token",
    displayName: "Workstation",
    machineId: principal.machineId,
    hostId: principal.hostId,
    clientVersion: "0.16.698",
    protocolVersion: 2,
    ...(activation ? { activation } : {}),
  };
}

test("recovering daemon cannot own or claim the route before StableGranted", async () => {
  const connectedEpochs = [];
  const authority = {
    capabilities: new Set(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate(message) {
      const activation = message.activation
        ? {
            type: "machine_activation_receipt",
            requestId: message.requestId,
            transactionId: message.activation.transactionId,
            artifactSha256: message.activation.artifactSha256,
            connectionEpoch: 8,
            phase: "recovering",
            receiptId: `recovering:${message.activation.transactionId}`,
          }
        : undefined;
      return {
        principal,
        connected: {
          type: "machine_daemon_connected",
          daemon: daemon(),
          connectionEpoch: activation ? 8 : 7,
          ...(activation ? { activation } : {}),
        },
      };
    },
    async refresh() { return principal; },
    async execute(_session, message) {
      if (message.type === "machine_activation_prepare") {
        return {
          type: "machine_activation_receipt",
          requestId: message.requestId,
          transactionId: message.transactionId,
          artifactSha256: message.artifactSha256,
          connectionEpoch: message.connectionEpoch,
          phase: "activation_prepared",
          receiptId: `prepared:${message.transactionId}:${message.runSetDigest}`,
          runSetDigest: message.runSetDigest,
        };
      }
      if (message.type === "machine_activation_advance") {
        return {
          type: "machine_activation_receipt",
          requestId: message.requestId,
          transactionId: message.transactionId,
          artifactSha256: message.artifactSha256,
          connectionEpoch: message.connectionEpoch,
          phase: message.phase === "abort" ? "aborted" : message.phase,
          receiptId: `${message.phase}:${message.transactionId}`,
        };
      }
      throw new Error("fenced candidate reached ordinary execution");
    },
    async connected(session) { connectedEpochs.push(session.connectionEpoch); },
    async disconnected() {},
  };
  const transport = new machine.MachineDaemonRuntimeTransport(authority);
  const oldSocket = new FakeSocket();
  const candidateSocket = new FakeSocket();
  transport.accept(oldSocket);
  await transport.handleFrame(oldSocket, JSON.stringify(connectFrame("old-connect")));
  transport.accept(candidateSocket);
  await transport.handleFrame(candidateSocket, JSON.stringify(connectFrame("candidate-connect", {
    mode: "recovering",
    transactionId: "tx-1",
    transactionNonce: "nonce-1",
    artifactSha256: "a".repeat(64),
    sourceConnectionEpoch: 7,
  })));

  assert.deepEqual(connectedEpochs, [7]);
  assert.deepEqual(oldSocket.closed, []);
  assert.equal(transport.hibernationAttachment(candidateSocket), undefined);
  await transport.deliver(principal, { type: "shutdown_requested", reason: "old-owner" });
  assert.equal(oldSocket.sent.at(-1).reason, "old-owner");
  assert.notEqual(candidateSocket.sent.at(-1)?.reason, "old-owner");

  await transport.handleFrame(candidateSocket, JSON.stringify({
    type: "machine_run_snapshot",
    runs: [],
    snapshotComplete: true,
  }));
  assert.match(candidateSocket.sent.at(-1).message, /fenced/u);
  assert.equal(candidateSocket.sent.at(-1).failure.code, "machine_activation_fenced");

  const identity = {
    transactionId: "tx-1",
    artifactSha256: "a".repeat(64),
    connectionEpoch: 8,
  };
  await transport.handleFrame(candidateSocket, JSON.stringify({
    type: "machine_activation_prepare",
    requestId: "prepare-1",
    ...identity,
    runSetDigest: "b".repeat(64),
    expectedRunIds: [],
    adoptedRunIds: [],
    naturalTerminalRunIds: [],
  }));
  for (const phase of ["active_fenced", "active", "stable_granted"]) {
    await transport.handleFrame(candidateSocket, JSON.stringify({
      type: "machine_activation_advance",
      requestId: `advance-${phase}`,
      ...identity,
      phase,
    }));
  }

  assert.deepEqual(connectedEpochs, [7, 8]);
  assert.deepEqual(oldSocket.closed, [{
    code: 4001,
    reason: "Replaced by a newer Machine Daemon connection",
  }]);
  assert.equal(transport.session(candidateSocket).activationPhase, undefined);
  await transport.deliver(principal, { type: "shutdown_requested", reason: "new-owner" });
  assert.equal(candidateSocket.sent.at(-1).reason, "new-owner");
});

test("only a full snapshot claims pending commands on its frame; a partial one is progress", async () => {
  let claims = 0;
  const authority = {
    capabilities: new Set(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate(message) {
      return { principal, connected: { type: "machine_daemon_connected", daemon: daemon(), connectionEpoch: 7,
        requestId: message.requestId } };
    },
    async refresh() { return principal; },
    async execute() { return undefined; },
    async connected() { claims += 1; },
    async disconnected() {},
  };
  const transport = new machine.MachineDaemonRuntimeTransport(authority);
  const socket = new FakeSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, JSON.stringify(connectFrame("connect")));
  const connectClaims = claims;
  await transport.handleFrame(socket, JSON.stringify({ type: "machine_run_snapshot", snapshotComplete: false,
    runs: [{ runId: "run-1" }] }));
  assert.equal(claims, connectClaims);
  await transport.handleFrame(socket, JSON.stringify({ type: "machine_run_snapshot", snapshotComplete: true, runs: [] }));
  assert.equal(claims, connectClaims + 1);
});

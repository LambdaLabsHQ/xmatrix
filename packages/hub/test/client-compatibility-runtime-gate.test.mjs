import assert from "node:assert/strict";
import test from "node:test";

import * as humanModule from "../src/runtime-transport/human-port.ts";
import * as machineModule from "../src/runtime-transport/machine-daemon-port.ts";
import * as agentModule from "../src/runtime-transport/agent-instance-port.ts";
import { FakeSocket } from "./support/runtime-transport.mjs";

function forbiddenAuthority(capabilities, calls) {
  return {
    capabilities: new Set(capabilities),
    async authenticate() {
      calls.push("authenticate");
      throw new Error("incompatible traffic reached Authority");
    },
    async focusChannel() { throw new Error("not used"); },
    async resolveMachineRequest() { throw new Error("not used"); },
    async refresh() { throw new Error("not used"); },
    async execute() { throw new Error("not used"); },
    async disconnected() {},
  };
}

test("all three realtime domains reject old clients before Authority authentication", async () => {
  const cases = [
    {
      Transport: humanModule.HumanRuntimeTransport,
      capabilities: humanModule.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES,
      frame: {
        type: "human_connect",
        requestId: "human-old",
        token: "token",
        device: { client: "desktop", version: "0.15.51", protocolVersion: 1 },
      },
    },
    {
      Transport: machineModule.MachineDaemonRuntimeTransport,
      capabilities: machineModule.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES,
      frame: {
        type: "machine_daemon_connect",
        requestId: "machine-old",
        token: "token",
        displayName: "Machine",
        machineId: "machine-1",
        hostId: "host-1",
        clientVersion: "0.15.52",
        protocolVersion: 1,
      },
    },
    {
      Transport: agentModule.AgentInstanceRuntimeTransport,
      capabilities: agentModule.AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
      frame: {
        type: "agent_instance_connect",
        requestId: "agent-old",
        token: "token",
        name: "Agent",
        runtime: { kind: "codex", clientVersion: "0.15.52", protocolVersion: 1 },
      },
    },
  ];

  for (const { Transport, capabilities, frame } of cases) {
    const calls = [];
    const socket = new FakeSocket();
    const transport = new Transport(forbiddenAuthority(capabilities, calls));
    transport.accept(socket);
    await transport.handleFrame(socket, JSON.stringify(frame));

    assert.deepEqual(calls, [], frame.type);
    assert.equal(socket.sent.length, 1, frame.type);
    assert.equal(socket.sent[0].type, "error", frame.type);
    assert.match(socket.sent[0].message, /no longer compatible|update/u, frame.type);
    assert.deepEqual(
      socket.closed,
      [{ code: 4003, reason: "Client upgrade required" }],
      frame.type,
    );
    assert.equal(transport.session(socket), undefined, frame.type);
  }
});

test("the protocol-generation cutover closes the bounded legacy lane", () => {
  for (const compatibility of [
    machineModule.machineDaemonCompatibility,
    agentModule.agentInstanceCompatibility,
  ]) {
    assert.equal(compatibility("0.15.63", undefined, false).compatible, false);
    assert.equal(compatibility("0.15.63", undefined, true).compatible, false);
    assert.equal(compatibility("0.15.52", undefined, true).compatible, false);
    assert.equal(compatibility("0.15.64", undefined, true).compatible, false);
    assert.equal(compatibility("0.15.63", 999, true).compatible, false);
  }

  const legacyDesktop = {
    type: "human_connect",
    requestId: "human-legacy",
    token: "token",
    device: { client: "desktop", version: "0.15.63" },
  };
  assert.equal(humanModule.humanMessageCompatibility(legacyDesktop, false).compatible, false);
  assert.equal(humanModule.humanMessageCompatibility(legacyDesktop, true).compatible, false);
  assert.equal(humanModule.humanMessageCompatibility({
    ...legacyDesktop,
    device: { ...legacyDesktop.device, version: "0.15.51" },
  }, true).compatible, false);
  assert.equal(humanModule.humanMessageCompatibility({
    ...legacyDesktop,
    device: { ...legacyDesktop.device, version: "0.15.64" },
  }, true).compatible, false);
  assert.equal(humanModule.humanMessageCompatibility({
    ...legacyDesktop,
    device: { ...legacyDesktop.device, protocolVersion: 999 },
  }, true).compatible, false);
});

for (const { name, options, client } of [
  {
    name: "an old hibernated Human socket is closed instead of restored",
    client: { clientVersion: "0.15.51", clientProtocolVersion: 1 },
  },
  {
    name: "a published pre-boundary Human socket is closed after the protocol-generation cutover",
    options: { allowLegacyProtocol: true },
    client: { clientVersion: "0.15.63" },
  },
]) {
  test(name, () => {
    const calls = [];
    const transport = new humanModule.HumanRuntimeTransport(
      forbiddenAuthority(humanModule.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES, calls),
      ...(options ? [options] : []),
    );
    const socket = new FakeSocket();
    const restored = transport.rehydrate(socket, {
      version: 1,
      domain: "human",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      session: {
        user: { id: "user-1", email: "user@example.test" },
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        focusedChannelId: null,
        deviceClient: "desktop",
        ...client,
      },
    });

    assert.equal(restored, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(socket.closed, [{ code: 4003, reason: "Client upgrade required" }]);
    assert.equal(transport.session(socket), undefined);
  });
}

test("a refused Human credential is a typed auth failure that closes the socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { PostgresHumanPort } = await import("../src/runtime-transport/postgres-human-port.ts");
  const { InvalidAuthTokenError } = await import("../src/auth.ts");
  for (const authenticate of [
    async () => { throw new InvalidAuthTokenError(); },
    async () => ({ id: "user-1", email: "user@example.test", agentRun: { runId: "run-1" } }),
  ]) {
    const port = new PostgresHumanPort({ authenticate, readHistory: async () => { throw new Error("unexpected history read"); } });
    port.capabilities = new Set(humanModule.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES);
    const transport = new humanModule.HumanRuntimeTransport(port);
    const socket = new FakeSocket();
    transport.accept(socket);
    await transport.handleFrame(socket, JSON.stringify({ type: "human_connect", requestId: "web-subscribe", token: "expired",
      device: { client: "xmatrix-cli-chat", version: "0.16.800", protocolVersion: 2 } }));
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].type, "error");
    assert.equal(socket.sent[0].failure.code, "human_auth_invalid");
    assert.match(socket.sent[0].message, /Sign in again/u);
    assert.equal(transport.session(socket), undefined);
    // Held open, so a client that redials only on close cannot loop faster than this.
    assert.deepEqual(socket.closed ?? [], []);
    t.mock.timers.tick(29_999);
    assert.deepEqual(socket.closed ?? [], []);
    t.mock.timers.tick(1);
    assert.deepEqual(socket.closed, [{ code: 4401, reason: "Sign in again" }]);
  }
});

test("an outage while checking a Human credential is not a sign-out", async () => {
  const { PostgresHumanPort } = await import("../src/runtime-transport/postgres-human-port.ts");
  const outage = Object.assign(new Error("connection terminated unexpectedly"), { code: "57P01" });
  const port = new PostgresHumanPort({ authenticate: async () => { throw outage; }, readHistory: async () => { throw new Error("unexpected history read"); } });
  port.capabilities = new Set(humanModule.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES);
  const transport = new humanModule.HumanRuntimeTransport(port);
  const socket = new FakeSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, JSON.stringify({ type: "human_connect", requestId: "web-subscribe", token: "valid",
    device: { client: "xmatrix-cli-chat", version: "0.16.800", protocolVersion: 2 } }));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, "error");
  assert.notEqual(socket.sent[0].failure?.code, "human_auth_invalid");
  assert.doesNotMatch(socket.sent[0].message, /Sign in again/u);
  assert.deepEqual(socket.closed, [{ code: 1013, reason: "Try again later" }]);
  assert.equal(transport.session(socket), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import * as bounds from "../src/runtime-transport/hibernation-bounds.ts";
import * as hibernation from "../src/runtime-transport/machine-daemon-hibernation.ts";
import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import * as human from "../src/runtime-transport/human-port.ts";
import * as agent from "../src/runtime-transport/agent-instance-port.ts";
import * as adapter from "../src/runtime-transport/relay-runtime-product-adapter.ts";
import { AttachedSocket } from "./support/runtime-transport.mjs";

const principal = Object.freeze({
  ownerUserId: "user-1",
  ownerEmail: "owner@example.test",
  machineId: "machine-1",
  hostId: "host-1",
});

function expiredMachineAttachment(overrides = {}) {
  return {
    version: 1,
    domain: "machine_daemon",
    expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    session: {
      principal,
      connectionEpoch: 7,
      displayName: "xmatrix-daemon-cursor",
      clientVersion: "0.16.698",
      clientProtocolVersion: 2,
      capabilities: ["machine_run_snapshot_causal_v1"],
      machineMetadata: { kind: "daemon", hostId: "cursor" },
      connectedAt: "2026-09-11T17:00:00.000Z",
      lastSeenAt: "2026-09-11T17:00:00.000Z",
      ...overrides.session,
    },
    ...overrides,
  };
}

function silentAuthority(capabilities) {
  return {
    capabilities: new Set(capabilities),
    async authenticate() { throw new Error("rehydrate must not authenticate"); },
    async refresh() { throw new Error("rehydrate must not refresh"); },
    async execute() { throw new Error("rehydrate must not execute"); },
    async disconnected() {},
  };
}

function oldFifteenMinuteExpiry(value) {
  const now = Date.now();
  const expires = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(expires) && expires > now &&
    expires <= now + bounds.RUNTIME_HIBERNATION_MAX_AGE_MS + 1_000;
}

test("one-hour-stale attachment is the production failure mode under the old 15-minute TTL", () => {
  const expiredOneHour = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.equal(oldFifteenMinuteExpiry(expiredOneHour), false, "old TTL rejects after 15 minutes");
  assert.equal(bounds.hibernationValidExpiry(expiredOneHour), true, "restore grace accepts the live socket");
  assert.equal(oldFifteenMinuteExpiry(new Date(Date.now() + 60_000).toISOString()), true);
  assert.equal(
    bounds.hibernationValidExpiry(new Date(Date.now() - bounds.RUNTIME_HIBERNATION_RESTORE_GRACE_MS - 1_000).toISOString()),
    false,
  );
  assert.equal(
    bounds.hibernationValidExpiry(new Date(Date.now() + bounds.RUNTIME_HIBERNATION_MAX_AGE_MS + 5_000).toISOString()),
    false,
  );
});

test("Machine Daemon parse restores a one-hour-stale attachment and still rejects junk", () => {
  const parsed = hibernation.parseMachineDaemonHibernationAttachment(expiredMachineAttachment());
  assert.equal(parsed?.session.connectionEpoch, 7);
  assert.equal(
    hibernation.parseMachineDaemonHibernationAttachment(expiredMachineAttachment({
      expiresAt: new Date(Date.now() - bounds.RUNTIME_HIBERNATION_RESTORE_GRACE_MS - 1_000).toISOString(),
    })),
    undefined,
  );
  assert.equal(
    hibernation.parseMachineDaemonHibernationAttachment({ version: 1, domain: "machine_daemon" }),
    undefined,
  );
});

test("Machine Daemon rehydrate restores an expired live attachment instead of closing", () => {
  const transport = new machine.MachineDaemonRuntimeTransport(
    silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
  );
  const socket = new AttachedSocket();
  const restored = transport.rehydrate(socket, expiredMachineAttachment());
  assert.equal(restored, true);
  assert.deepEqual(socket.closed, []);
  assert.equal(transport.session(socket)?.principal.machineId, principal.machineId);
  assert.equal(transport.session(socket)?.connectionEpoch, 7);
});

function productFactory() {
  return {
    human() { return silentAuthority(human.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES); },
    agentInstance() {
      return silentAuthority(agent.AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES);
    },
    machineDaemon() {
      return silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES);
    },
  };
}

test("product adapter wake restores an expired Machine Daemon socket as the route owner", () => {
  const socket = new AttachedSocket(expiredMachineAttachment());
  const product = adapter.createRelayRuntimeProductAdapter(
    { getWebSockets: () => [socket] },
    productFactory(),
  );
  assert.deepEqual(socket.closed, []);
  assert.equal(product.owns(socket), true);
});

test("product adapter still closes a structurally invalid Machine Daemon attachment", () => {
  const socket = new AttachedSocket({ version: 1, domain: "machine_daemon", expiresAt: "nope" });
  const product = adapter.createRelayRuntimeProductAdapter(
    { getWebSockets: () => [socket] },
    productFactory(),
  );
  assert.deepEqual(socket.closed, [{ code: 1008, reason: "Invalid product hibernation attachment" }]);
  assert.equal(product.owns(socket), false);
});

test("hostname changes preserve a Machine route while owner and Machine changes isolate it", () => {
  const sameMachine = { ...principal, hostId: "renamed-host" };
  assert.equal(machine.machineDaemonRouteKey(principal), machine.machineDaemonRouteKey(sameMachine));
  assert.notEqual(machine.machineDaemonRouteKey(principal), machine.machineDaemonRouteKey({ ...principal, machineId: "machine-2" }));
  assert.notEqual(machine.machineDaemonRouteKey(principal), machine.machineDaemonRouteKey({ ...principal, ownerUserId: "user-2" }));
  const attachment = expiredMachineAttachment({ session: { ...expiredMachineAttachment().session, principal: { ...principal } } });
  delete attachment.session.principal.hostId;
  assert.ok(hibernation.parseMachineDaemonHibernationAttachment(attachment), "credentials no longer need a hostname");
});

test("hostname-only daemon observations survive hibernation without becoming route identity", () => {
  const session = expiredMachineAttachment().session;
  session.principal = { ownerUserId: principal.ownerUserId, ownerEmail: principal.ownerEmail,
    machineId: principal.machineId, hostname: "current-computer" };
  const attachment = hibernation.serializeMachineDaemonHibernationAttachment(session);
  const restored = hibernation.parseMachineDaemonHibernationAttachment(attachment);
  assert.equal(restored.session.principal.hostname, "current-computer");
  assert.equal(machine.machineDaemonRouteKey(restored.session.principal), machine.machineDaemonRouteKey(principal));
  for (const hostname of ["x".repeat(161), { machineId: "other" }]) {
    assert.equal(hibernation.parseMachineDaemonHibernationAttachment({ ...attachment,
      session: { ...session, principal: { ...session.principal, hostname } } }), undefined);
  }
});

test("a production-sized Machine Daemon session refreshes its attachment, and only the platform limit refuses it", () => {
  const session = expiredMachineAttachment().session;
  const harnesses = Array.from({ length: 12 }, (_, index) => ({ id: `harness-${index}`, version: "1.2.3",
    path: `/home/user/.local/bin/harness-${index}`, models: ["model-a", "model-b", "model-c"], updatedAt: session.connectedAt }));
  const capabilities = Array.from({ length: 30 }, (_, index) => `machine_capability_number_${index}_v1`);
  const sized = { ...session, capabilities, machineMetadata: { kind: "daemon", harnesses, capabilities,
    machineResources: { cpu: { cores: 8, model: "x".repeat(200) }, memory: { totalBytes: 34359738368 } } } };
  assert.ok(JSON.stringify(sized).length > 4_096, "the fixture is larger than the old bound");
  const attachment = hibernation.serializeMachineDaemonHibernationAttachment(sized);
  assert.deepEqual(hibernation.parseMachineDaemonHibernationAttachment(attachment).session.machineMetadata, sized.machineMetadata);
  assert.throws(() => hibernation.serializeMachineDaemonHibernationAttachment({ ...sized,
    machineMetadata: { ...sized.machineMetadata, padding: "x".repeat(bounds.RUNTIME_HIBERNATION_MAX_ATTACHMENT_BYTES) } }),
  /cannot be serialized as a bounded hibernation attachment/u);
});

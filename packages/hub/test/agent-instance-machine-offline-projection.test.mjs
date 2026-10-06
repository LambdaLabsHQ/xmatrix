import assert from "node:assert/strict";
import { test } from "node:test";

import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import * as human from "../src/runtime-transport/human-port.ts";
import * as agent from "../src/runtime-transport/agent-instance-port.ts";
import * as adapter from "../src/runtime-transport/relay-runtime-product-adapter.ts";
import {
  liveAgentSessionSnapshots,
  overlayChannelsWithLiveAgentPresence,
} from "../src/runtime-transport/agent-presence-snapshot.ts";
import { agentInstanceAttachment, AttachedSocket } from "./support/runtime-transport.mjs";

// Incident 2026-10-01: a wedged daemon's Instances kept their own sockets open
// and kept reporting idle, so every reader showed them idle while nothing sent
// to them was acted on. The projection must follow the machine, not the socket.

const route = Object.freeze({ ownerUserId: "owner-1", machineId: "machine-1", hostId: "host-1" });
const principal = Object.freeze({ ...route, ownerEmail: "owner@example.test" });

function daemonAttachment({ lastSeenAt = new Date().toISOString(), capabilities } = {}) {
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
      capabilities: capabilities ?? ["machine_liveness_ping_v1"],
      machineMetadata: {},
      connectedAt: lastSeenAt,
      lastSeenAt,
    },
  };
}

function instanceAttachment() {
  return agentInstanceAttachment({
    principal: { ...route, agentName: "Claude" },
    run: { channelInstanceId: "1", instanceStatus: "idle" },
  });
}

function silentAuthority(capabilities) {
  return {
    capabilities: new Set(capabilities),
    async authenticate() { throw new Error("unexpected authenticate"); },
    async refresh() { throw new Error("unexpected refresh"); },
    async execute() { throw new Error("unexpected execute"); },
    async disconnected() {},
  };
}

function product(sockets) {
  const presenceChanges = [];
  const runtime = adapter.createRelayRuntimeProductAdapter({ getWebSockets: () => sockets }, {
    human: () => silentAuthority(human.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES),
    agentInstance: () => silentAuthority(agent.AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
    machineDaemon: () => silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    onAgentPresenceChange: (input) => {
      presenceChanges.push({ reason: input.reason, reachable: input.machineReachable?.(input.session) });
    },
  });
  return { runtime, presenceChanges };
}

function shown(runtime) {
  const sessions = runtime.liveAgentSessions();
  const [channel] = overlayChannelsWithLiveAgentPresence(
    [{ id: sessions[0]?.channelId ?? "channel-1" }],
    sessions,
  );
  const instance = Object.values(channel.memberPresence ?? {})
    .flatMap((presence) => presence.instances ?? [])[0];
  return {
    status: instance?.status,
    offlineReason: instance?.offlineReason,
    instance: instance?.status,
  };
}

test("an Instance whose daemon is connected is shown as it reports", () => {
  const { runtime } = product([new AttachedSocket(instanceAttachment()), new AttachedSocket(daemonAttachment())]);
  assert.deepEqual(shown(runtime), { status: "idle", offlineReason: undefined, instance: "idle" });
});

test("an Instance whose daemon disconnected is shown offline, and readers are told", async () => {
  const daemonSocket = new AttachedSocket(daemonAttachment());
  const { runtime, presenceChanges } = product([new AttachedSocket(instanceAttachment()), daemonSocket]);
  presenceChanges.length = 0;

  await runtime.webSocketClose(daemonSocket, 1006, "", false);

  assert.deepEqual(shown(runtime), { status: "offline", offlineReason: "machine_offline", instance: "offline" });
  assert.deepEqual(presenceChanges, [{ reason: "update", reachable: false }]);
});

test("an Instance with no daemon at all is shown offline", () => {
  const { runtime } = product([new AttachedSocket(instanceAttachment())]);
  assert.equal(shown(runtime).status, "offline");
});

test("a quiet connected daemon stays reachable even with the retired ping capability", async () => {
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const capabilities of [[], ["machine_liveness_ping_v1"]]) {
    const daemonSocket = new AttachedSocket(daemonAttachment({ lastSeenAt: longAgo, capabilities }));
    const { runtime, presenceChanges } = product([new AttachedSocket(instanceAttachment()), daemonSocket]);
    assert.deepEqual(shown(runtime), { status: "idle", offlineReason: undefined, instance: "idle" });
    presenceChanges.length = 0;
    await runtime.webSocketMessage(daemonSocket, JSON.stringify({ type: "ping", requestId: "p-1" }));
    assert.deepEqual(presenceChanges, [], "an optional old-client ping is not a reachability transition");
    assert.deepEqual(daemonSocket.closed, []);
  }
});

test("a daemon socket error pushes machine-offline presence", async () => {
  const daemonSocket = new AttachedSocket(daemonAttachment());
  const { runtime, presenceChanges } = product([new AttachedSocket(instanceAttachment()), daemonSocket]);
  presenceChanges.length = 0;
  await runtime.webSocketError(daemonSocket);
  assert.equal(shown(runtime).offlineReason, "machine_offline");
  assert.deepEqual(presenceChanges, [{ reason: "update", reachable: false }]);
});

test("a reconnected daemon brings its Instances back to their reported status", async () => {
  const transport = new machine.MachineDaemonRuntimeTransport({
    ...silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() {
      return {
        principal,
        connected: {
          type: "machine_daemon_connected",
          connectionEpoch: 4,
          daemon: {
            id: "daemon-1", userId: route.ownerUserId, email: principal.ownerEmail, name: "Workstation",
            machineId: route.machineId, hostId: route.hostId, status: "online", metadata: {},
            connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
          },
        },
      };
    },
  });
  const session = instanceAttachment().session;
  const snapshot = () => liveAgentSessionSnapshots([session], undefined, (target) =>
    transport.isRouteReachable(target))[0];

  assert.equal(overlayChannelsWithLiveAgentPresence([{ id: "channel-1" }], [snapshot()])[0]
    .memberPresence["agent-1"].instances[0].status, "offline");

  const socket = new AttachedSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, JSON.stringify({
    type: "machine_daemon_connect", requestId: "connect-1", token: "token", displayName: "Workstation",
    machineId: route.machineId, hostId: route.hostId, clientVersion: "0.16.698", protocolVersion: 2,
    capabilities: ["machine_liveness_ping_v1"],
  }));

  assert.equal(overlayChannelsWithLiveAgentPresence([{ id: "channel-1" }], [snapshot()])[0]
    .memberPresence["agent-1"].instances[0].status, "idle");
  assert.equal(transport.isRouteReachable({ ...route, hostId: "other-host" }), true,
    "hostname is only an observation");
  assert.equal(transport.isRouteReachable({ ...route, machineId: "other-machine" }), false);
  assert.equal(transport.isRouteReachable({ ...route, ownerUserId: "other-owner" }), false);
});

test("channel views project the same offline Instance, and keep it in the Channel", () => {
  const session = instanceAttachment().session;
  const [snapshot] = liveAgentSessionSnapshots([session], undefined, () => false);
  const [channel] = overlayChannelsWithLiveAgentPresence([{ id: "channel-1" }], [snapshot]);
  const [instance] = channel.memberPresence["agent-1"].instances;
  assert.equal(instance.status, "offline");
  assert.equal(instance.offlineReason, "machine_offline");
});

test("claiming commands on a closed socket evicts it and persists the route offline", async () => {
  const disconnects = [];
  let claims = 0;
  const transport = new machine.MachineDaemonRuntimeTransport({
    ...silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async claimPending() { claims += 1; return 1; },
    async disconnected(_session, details) { disconnects.push(details.code); },
  });
  const socket = new AttachedSocket();
  const silentSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(transport.rehydrate(socket, daemonAttachment({ lastSeenAt: silentSince })), true);

  socket.readyState = 3;
  const result = await transport.claimPending(route);

  assert.equal(claims, 0, "no lease may go to a daemon that cannot act on it");
  assert.equal(result.owners, 0);
  assert.deepEqual(socket.closed.map(({ code }) => code), [machine.MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver.code]);
  assert.deepEqual(disconnects, [machine.MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver.code]);
});


test("a failed command send evicts the route and publishes offline without a timer", async () => {
  const disconnects = [];
  const edges = [];
  const transport = new machine.MachineDaemonRuntimeTransport({
    ...silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async claimPending(_session, deliver) {
      await deliver({ type: "pong", requestId: "command", ts: new Date().toISOString() });
      return 1;
    },
    async disconnected(_session, details) { disconnects.push(details.code); },
  }, false, undefined, (identity) => edges.push(transport.isRouteReachable(identity)));
  const socket = new AttachedSocket();
  transport.rehydrate(socket, daemonAttachment());
  socket.send = () => { throw new Error("transport send failed"); };
  const result = await transport.claimPending(route);
  assert.equal(result.owners, 0);
  assert.equal(transport.isRouteReachable(route), false);
  assert.deepEqual(edges, [false]);
  assert.deepEqual(disconnects, [machine.MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver.code]);
});

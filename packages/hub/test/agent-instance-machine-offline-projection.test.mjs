import assert from "node:assert/strict";
import { test } from "node:test";

import * as machine from "../src/runtime-transport/machine-daemon-port.ts";
import * as human from "../src/runtime-transport/human-port.ts";
import * as agent from "../src/runtime-transport/agent-instance-port.ts";
import * as adapter from "../src/runtime-transport/relay-runtime-product-adapter.ts";
import { createProductionRelayRuntimeProductPortFactory } from "../src/runtime-transport/production-product-port-factory.ts";
import { agentInstanceAttachment, AttachedSocket, socketFrame } from "./support/runtime-transport.mjs";

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

/**
 * One cell's Runtime product over these sockets, its presence reports
 * published as production publishes them. Records what each person is sent.
 */
function product(sockets) {
  const presenceChanges = [];
  const frames = [];
  const published = [];
  const publication = createProductionRelayRuntimeProductPortFactory({}, {
    readChannel: async () => ({ channel: catalogChannel(), openChannelHumanMemberIdsBySpace: { space: ["user:owner-1", "user:viewer"] } }),
    readViewers: async () => ["owner-1", "viewer"],
    readOwnerQuota: async () => [],
    readQuota: async () => undefined,
    analytics: { writeDataPoint() {} },
    readHistory: async () => { throw Error("unexpected history"); },
  });
  const runtime = adapter.createRelayRuntimeProductAdapter({ getWebSockets: () => sockets }, {
    human: () => silentAuthority(human.HUMAN_AUTHORITY_REQUIRED_CAPABILITIES),
    agentInstance: () => ({ ...silentAuthority(agent.AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES), async execute() {} }),
    machineDaemon: () => silentAuthority(machine.MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    onAgentPresenceChange: (input) => {
      presenceChanges.push({ reason: input.reason, reachable: input.machineReachable?.(input.session) });
      const report = publication.onAgentPresenceChange({ ...input,
        deliver: (userId, frame) => frames.push({ userId, frame }),
        deliverAgentPresence: (userId, _channelId, card, channel) => {
          if (card) frames.push({ userId, frame: card });
          if (channel) frames.push({ userId, frame: channel });
        },
        deliverPresenceChannel: (userId, channel) => frames.push({ userId, frame: channel }),
      });
      published.push(report);
      return report;
    },
  });
  // The Instance reports what it is doing, as it does over its socket.
  const report = (status) => runtime.webSocketMessage(sockets[0], socketFrame("presence_update", { status }));
  return { runtime, presenceChanges, frames, report, settled: () => Promise.all(published) };
}

/** How the last card a person was sent shows the Instance. */
function shown(frames, userId = "owner-1") {
  const card = frames.filter((sent) => sent.userId === userId && sent.frame.type === "enhanced_presence").at(-1);
  return { status: card?.frame.agent.status, offlineReason: card?.frame.agent.offlineReason };
}

test("an Instance whose daemon is connected is shown as it reports", async () => {
  const { report, frames } = product([new AttachedSocket(instanceAttachment()), new AttachedSocket(daemonAttachment())]);
  await report("idle");
  assert.deepEqual(shown(frames), { status: "idle", offlineReason: undefined });
  assert.deepEqual(shown(frames, "viewer"), { status: "idle", offlineReason: undefined });
});

test("an Instance whose daemon disconnected is shown offline, and readers are told", async () => {
  const daemonSocket = new AttachedSocket(daemonAttachment());
  const { runtime, presenceChanges, frames, settled } = product([new AttachedSocket(instanceAttachment()), daemonSocket]);

  await runtime.webSocketClose(daemonSocket, 1006, "", false);
  await settled();

  assert.deepEqual(presenceChanges, [{ reason: "update", reachable: false }]);
  for (const userId of ["owner-1", "viewer"]) {
    assert.deepEqual(shown(frames, userId), { status: "offline", offlineReason: "machine_offline" });
  }
});

test("an Instance with no daemon at all is shown offline", async () => {
  const { report, frames } = product([new AttachedSocket(instanceAttachment())]);
  await report("idle");
  assert.deepEqual(shown(frames), { status: "offline", offlineReason: "machine_offline" });
});

test("a quiet connected daemon stays reachable even with the retired ping capability", async () => {
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const capabilities of [[], ["machine_liveness_ping_v1"]]) {
    const daemonSocket = new AttachedSocket(daemonAttachment({ lastSeenAt: longAgo, capabilities }));
    const { runtime, presenceChanges, frames, report } = product([new AttachedSocket(instanceAttachment()), daemonSocket]);
    await report("idle");
    assert.deepEqual(shown(frames), { status: "idle", offlineReason: undefined });
    presenceChanges.length = 0;
    await runtime.webSocketMessage(daemonSocket, JSON.stringify({ type: "ping", requestId: "p-1" }));
    assert.deepEqual(presenceChanges, [], "an optional old-client ping is not a reachability transition");
    assert.deepEqual(daemonSocket.closed, []);
  }
});

test("a daemon socket error pushes machine-offline presence", async () => {
  const daemonSocket = new AttachedSocket(daemonAttachment());
  const { runtime, presenceChanges, frames, settled } = product([new AttachedSocket(instanceAttachment()), daemonSocket]);
  await runtime.webSocketError(daemonSocket);
  await settled();
  assert.deepEqual(shown(frames), { status: "offline", offlineReason: "machine_offline" });
  assert.deepEqual(presenceChanges, [{ reason: "update", reachable: false }]);
});

test("a reconnected daemon makes its route reachable again, and says so", async () => {
  const edges = [];
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
  }, false, undefined, (identity) => edges.push(transport.isRouteReachable(identity)));

  assert.equal(transport.isRouteReachable(route), false);

  const socket = new AttachedSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, JSON.stringify({
    type: "machine_daemon_connect", requestId: "connect-1", token: "token", displayName: "Workstation",
    machineId: route.machineId, hostId: route.hostId, clientVersion: "0.16.698", protocolVersion: 2,
    capabilities: ["machine_liveness_ping_v1"],
  }));

  // The adapter re-publishes the route's Instances on every edge, as the tests above see it do.
  assert.deepEqual(edges, [true]);
  assert.equal(transport.isRouteReachable({ ...route, hostId: "other-host" }), true,
    "hostname is only an observation");
  assert.equal(transport.isRouteReachable({ ...route, machineId: "other-machine" }), false);
  assert.equal(transport.isRouteReachable({ ...route, ownerUserId: "other-owner" }), false);
});

test("channel views project the same offline Instance, and keep it in the Channel", async () => {
  const { report, frames } = product([new AttachedSocket(instanceAttachment())]);
  await report("idle");
  const views = frames.filter(({ frame }) => frame.type === "channel_updated");
  assert.deepEqual(views.map(({ userId }) => userId), ["owner-1", "viewer"]);
  for (const { frame } of views) {
    const [instance] = frame.channel.memberPresence["instance-1"].instances;
    assert.equal(instance.status, "offline");
    assert.equal(instance.offlineReason, "machine_offline");
  }
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

function catalogChannel() {
  const { session } = instanceAttachment();
  return { id: session.run.channelId, spaceId: "space", name: "channel", mode: "open",
    createdAt: session.connectedAt, updatedAt: session.connectedAt, memberPresence: { [session.run.instanceId]: {
      kind: "agent", label: "Claude", registration: { ownerUserId: route.ownerUserId, machineId: route.machineId, harness: "claude" },
      instances: [{ id: session.run.instanceId, channelId: session.run.channelId, channelInstanceId: session.run.channelInstanceId,
        connectedAt: session.connectedAt, lastSeenAt: session.lastSeenAt, status: "idle" }],
    } } };
}

import assert from "node:assert/strict";
import { test } from "node:test";

import { RelayRuntimeLive } from "../src/relay-runtime.ts";
import { publishChannelLiveDelivery } from "../src/channel-messages.ts";
import { relayChannelCatalogPublishCommittedChanges } from "../src/relay-channel-catalog-notification-delivery.ts";
import { RelayRuntimeProductCallbackAdapter } from "../src/runtime-transport/relay-runtime-product-adapter.ts";
import { HumanRuntimeTransport, HUMAN_AUTHORITY_REQUIRED_CAPABILITIES } from "../src/runtime-transport/human-port.ts";
import {
  AgentInstanceRuntimeTransport,
  AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/agent-instance-port.ts";
import {
  MachineDaemonRuntimeTransport,
  MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/machine-daemon-port.ts";
import {
  deliverToAudience,
  runtimeDeliveryPlan,
  runtimeJsonRequest,
  RUNTIME_CHANNEL_MESSAGE_URL,
} from "../src/runtime-transport/runtime-principal-delivery.ts";
import { agentInstanceAttachment, FakeSocket, machineDaemonConnectFrame } from "./support/runtime-transport.mjs";
import { recordingRuntimeNamespace } from "./support/runtime-namespace.mjs";

const now = new Date().toISOString();

/** A Human transport holding one live socket of `userId`. */
function humanCell(userId, { focusedChannelId = null, presenceCoverage = false } = {}) {
  const human = new HumanRuntimeTransport({ capabilities: new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES) });
  const socket = new FakeSocket();
  assert.equal(human.rehydrate(socket, { version: 1, domain: "human", expiresAt: new Date(Date.now() + 60_000).toISOString(), session: {
    user: { id: userId, email: `${userId}@example.test` }, connectedAt: now, lastSeenAt: now, focusedChannelId,
    deviceClient: "web", clientVersion: "1.8.0", clientProtocolVersion: 2,
    ...(presenceCoverage ? { presenceCoverage: true } : {}),
  } }), true);
  return { human, socket };
}

/** A Runtime cell over the real product handlers, holding these transports' sockets. */
function runtimeCell(human, agent) {
  const cell = Object.create(RelayRuntimeLive.prototype);
  cell.productAdapter = new RelayRuntimeProductCallbackAdapter(
    { getWebSockets: () => [], acceptWebSocket() {} },
    human ?? new HumanRuntimeTransport({ capabilities: new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES) }),
    agent ?? new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) }),
    {},
  );
  return cell;
}

/** A Runtime namespace whose named cells are `cells`; any other cell is an empty one. */
function runtimeEnv(cells, calls = []) {
  return {
    calls,
    env: { RELAY_RUNTIME: recordingRuntimeNamespace(calls, (name, request) => (cells.get(name) ?? runtimeCell()).fetch(request)) },
  };
}

const message = { channelId: "channel-1", messageId: "message-1", sequence: 1, body: "hello",
  from: { kind: "user", identityId: "user:sender", userId: "sender", label: "Sender" }, sentAt: now };
const received = (socket, type = "channel_message_received") => socket.sent.filter((frame) => frame.type === type).length;

test("a person who also owns the Channel's Instances is one cell serving both; an unroutable id reaches none", () => {
  const plan = runtimeDeliveryPlan({ humans: ["reader", "owner", "not a user"], instanceOwners: ["owner", "other-owner"] });
  assert.deepEqual([...plan], [
    ["user-reader", { owner: "reader", human: true, instances: false }],
    ["user-owner", { owner: "owner", human: true, instances: true }],
    ["user-other-owner", { owner: "other-owner", human: false, instances: true }],
  ]);
});

test("the publishing cell serves its own share locally and is never fetched, or is left out once it has", async () => {
  const calls = [];
  const env = { RELAY_RUNTIME: recordingRuntimeNamespace(calls, async () => Response.json({})) };
  const local = [];
  const self = { cellName: "user-reader", fetch: async (request) => { local.push(new URL(request.url).pathname); return Response.json({}); } };
  const request = (share) => runtimeJsonRequest(RUNTIME_CHANNEL_MESSAGE_URL, { owner: share.owner });
  assert.equal(await deliverToAudience({ env, audience: { humans: ["reader", "peer"] }, label: "test", self, request }), 2);
  assert.deepEqual(local, ["/internal/product/channel-message"]);
  assert.deepEqual(calls.map((call) => call.cell), ["user-peer"]);
  calls.length = 0;
  local.length = 0;
  assert.equal(await deliverToAudience({ env, audience: { humans: ["reader", "peer"] }, label: "test", self, skipSelf: true, request }), 1);
  assert.deepEqual(local, []);
  assert.deepEqual(calls.map((call) => call.cell), ["user-peer"]);
});

test("every failing cell is reported once all have settled, and the others still receive it", async () => {
  const calls = [];
  const env = { RELAY_RUNTIME: recordingRuntimeNamespace(calls, async (cell) => cell === "user-down"
    ? Response.json({ error: "refused" }, { status: 400 }) : Response.json({})) };
  await assert.rejects(deliverToAudience({ env, audience: { humans: ["down", "up-1", "up-2"] }, label: "test",
    request: () => runtimeJsonRequest(RUNTIME_CHANNEL_MESSAGE_URL, {}) }),
  (error) => error.name === "RuntimeDeliveryError" && error.failures.length === 1 && error.failures[0].cellName === "user-down");
  assert.deepEqual(calls.map((call) => call.cell).sort(), ["user-down", "user-up-1", "user-up-2"]);
});

test("no more cells than the budget are in flight at once", async () => {
  let inFlight = 0;
  let most = 0;
  const env = { RELAY_RUNTIME: recordingRuntimeNamespace([], async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return Response.json({});
  }) };
  const humans = Array.from({ length: 40 }, (_, index) => `reader-${index}`);
  assert.equal(await deliverToAudience({ env, audience: { humans }, label: "test", concurrency: 4,
    request: () => runtimeJsonRequest(RUNTIME_CHANNEL_MESSAGE_URL, {}) }), 40);
  assert.equal(most, 4);
});

test("a Space's catalog change reaches a person who is viewing no Channel, in their own cell, and nobody else", async () => {
  const reader = humanCell("reader");
  const outsider = humanCell("outsider");
  const { env, calls } = runtimeEnv(new Map([["user-reader", runtimeCell(reader.human)], ["user-outsider", runtimeCell(outsider.human)]]));
  await relayChannelCatalogPublishCommittedChanges({ env, changes: [{ spaceId: "space-1", revision: 7, recipientUserIds: ["reader"] }] });
  assert.deepEqual(reader.socket.sent, [{ type: "space_channel_catalog_changed", spaceId: "space-1", revision: 7 }]);
  assert.deepEqual(outsider.socket.sent, []);
  assert.deepEqual(calls.map((call) => call.cell), ["user-reader"]);
});

test("a message published in a reader's own cell reaches them there, without a call into that cell", async () => {
  const reader = humanCell("reader", { focusedChannelId: "channel-1" });
  const cell = runtimeCell(reader.human);
  const { env, calls } = runtimeEnv(new Map([["user-reader", { fetch: () => { throw new Error("Unexpected self RPC"); } }]]));
  await publishChannelLiveDelivery(env, () => {}, "channel-1", message,
    { cellName: "user-reader", fetch: (request) => cell.fetch(request) },
    { recipientUserIds: ["reader"], recipientNotifications: [], instanceOwnerUserIds: [] });
  assert.equal(received(reader.socket), 1);
  assert.deepEqual(calls, []);
});

test("a Channel's Agent receives a message once, however many people read the Channel", async () => {
  const agent = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) });
  const socket = new FakeSocket();
  assert.equal(agent.rehydrate(socket, agentInstanceAttachment()), true);
  const { env, calls } = runtimeEnv(new Map([["user-user-1", runtimeCell(undefined, agent)]]));
  const readers = ["user-1", ...Array.from({ length: 1000 }, (_, index) => `reader-${index}`)];
  await publishChannelLiveDelivery(env, () => {}, "channel-1", message, undefined,
    { recipientUserIds: readers, recipientNotifications: [], instanceOwnerUserIds: ["user-1"] });
  assert.equal(received(socket), 1);
  assert.equal(calls.length, 1001, "each reader's cell is reached once");
  assert.equal(calls.filter((call) => call.cell === "user-user-1").length, 1);
});

test("only a cell the plan names as holding Instances serves them; a publisher that names no share is served as before", async () => {
  const agent = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) });
  const socket = new FakeSocket();
  assert.equal(agent.rehydrate(socket, agentInstanceAttachment()), true);
  const cell = runtimeCell(undefined, agent);
  const post = (body) => cell.fetch(runtimeJsonRequest(RUNTIME_CHANNEL_MESSAGE_URL, { ...message, recipientUserIds: [], ...body }));
  assert.equal((await post({ instances: false })).status, 200);
  assert.equal(received(socket), 0);
  await post({ messageId: "message-2" });
  assert.equal(received(socket), 1);
});

test("a Channel snapshot that speaks only for Agents goes only to sockets that read that", () => {
  const { human, socket: covered } = humanCell("reader", { presenceCoverage: true });
  const legacy = new FakeSocket();
  assert.equal(human.rehydrate(legacy, { version: 1, domain: "human", expiresAt: new Date(Date.now() + 60_000).toISOString(), session: {
    user: { id: "reader", email: "reader@example.test" }, connectedAt: now, lastSeenAt: now, focusedChannelId: "channel-1",
    deviceClient: "web", clientVersion: "1.8.0", clientProtocolVersion: 2 } }), true);
  const card = { type: "enhanced_presence", agent: { id: "agent-1" } };
  const channel = { type: "channel_updated", channel: { id: "channel-1", memberPresence: {}, presenceCoverage: "agents" } };
  human.deliverAgentPresence("reader", "channel-1", card, channel);
  human.deliverPresenceChannel("reader", channel);
  assert.deepEqual(covered.sent.map((frame) => frame.type), ["enhanced_presence", "channel_updated", "channel_updated"]);
  assert.deepEqual(legacy.sent.map((frame) => frame.type), ["enhanced_presence"]);
});

/** A Human authority that authenticates any token as `userId`. */
function humanAuthority(userId) {
  return {
    capabilities: new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate(message) {
      const user = { id: userId, email: `${userId}@example.test` };
      return { user, connected: { type: "human_connected", requestId: message.requestId, user } };
    },
    async focusChannel() { return undefined; },
    async disconnected() {},
  };
}

const humanConnect = JSON.stringify({ type: "human_connect", requestId: "connect", token: "token",
  device: { client: "web", version: "1.8.0", protocolVersion: 2 } });

test("a person's socket is admitted only in their own cell", async () => {
  const admit = (ownerUserId) => ownerUserId === "reader" ? "admitted" : "foreign_cell";
  const own = new HumanRuntimeTransport(humanAuthority("reader"), { admit });
  const ownSocket = new FakeSocket();
  own.accept(ownSocket);
  await own.handleFrame(ownSocket, humanConnect);
  assert.equal(own.session(ownSocket)?.user.id, "reader");

  const foreign = new HumanRuntimeTransport(humanAuthority("intruder"), { admit });
  const socket = new FakeSocket();
  foreign.accept(socket);
  await foreign.handleFrame(socket, humanConnect);
  assert.equal(foreign.session(socket), undefined);
  assert.equal(socket.sent.at(-1).failure.code, "runtime_cell_foreign");
  assert.deepEqual(socket.closed, [{ code: 1008, reason: "Runtime cell is not this account's" }]);
});

test("a socket that named no owner is told to upgrade, before it can be served", async () => {
  const transport = new HumanRuntimeTransport(humanAuthority("reader"), { admit: () => "upgrade_required" });
  const socket = new FakeSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, humanConnect);
  assert.equal(transport.session(socket), undefined);
  assert.deepEqual(socket.closed, [{ code: 4003, reason: "Client upgrade required" }]);
});

test("a Machine Daemon of another account is refused in this cell", async () => {
  const principal = { ownerUserId: "intruder", ownerEmail: "intruder@example.test", machineId: "machine-1", hostId: "host-1" };
  const transport = new MachineDaemonRuntimeTransport({
    capabilities: new Set(MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() {
      return { principal, connected: { type: "machine_daemon_connected", connectionEpoch: 1,
        daemon: { id: "machine-1-daemon", userId: "intruder", email: principal.ownerEmail, machineId: "machine-1" } } };
    },
    async refresh() { return principal; },
    async execute() {},
    async disconnected() {},
  }, false, undefined, undefined, (ownerUserId) => ownerUserId === "owner" ? "admitted" : "foreign_cell");
  const socket = new FakeSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, machineDaemonConnectFrame(principal));
  assert.equal(transport.session(socket), undefined);
  assert.equal(socket.sent.at(-1).failure.code, "runtime_cell_foreign");
});

test("an Agent Instance of another owner is refused before it binds", async () => {
  const { session } = agentInstanceAttachment({ principal: { ownerUserId: "intruder" } });
  const transport = new AgentInstanceRuntimeTransport({
    capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() {
      return { principal: session.principal, run: session.run, connected: { type: "agent_instance_connected" } };
    },
  }, undefined, undefined, undefined, false, (ownerUserId) => ownerUserId === "owner" ? "admitted" : "foreign_cell");
  const socket = new FakeSocket();
  transport.accept(socket);
  await transport.handleFrame(socket, JSON.stringify({ type: "agent_instance_connect", requestId: "connect", token: "token",
    identityId: session.principal.agentId, name: session.principal.agentName,
    runtime: { kind: "codex", clientVersion: "1.8.0", protocolVersion: 2 },
    runContext: { runId: session.principal.runId, executionKey: session.principal.executionKey,
      autoJoinChannelId: session.principal.channelId, machineId: session.principal.machineId, hostId: session.principal.hostId } }));
  assert.equal(transport.session(socket), undefined);
  assert.equal(socket.sent.at(-1).failure.code, "runtime_cell_foreign");
  assert.equal(socket.closed.length, 1);
});

test("sockets back from hibernation in a cell that is not theirs are closed once the cell knows whose it is", () => {
  const { human, socket: own } = humanCell("reader");
  const stranger = new FakeSocket();
  assert.equal(human.rehydrate(stranger, { version: 1, domain: "human", expiresAt: new Date(Date.now() + 60_000).toISOString(), session: {
    user: { id: "stranger", email: "stranger@example.test" }, connectedAt: now, lastSeenAt: now, focusedChannelId: null,
    deviceClient: "web", clientVersion: "1.8.0", clientProtocolVersion: 2 } }), true);
  human.refuseForeignSockets((ownerUserId) => ownerUserId === "reader" ? "admitted" : "foreign_cell");
  assert.deepEqual(own.closed, []);
  assert.deepEqual(stranger.closed, [{ code: 1008, reason: "Runtime cell is not this account's" }]);
});

test("a cell admits only its owner's sockets, and the single cell admits none", () => {
  const cell = Object.create(RelayRuntimeLive.prototype);
  assert.equal(cell.admit("reader"), "upgrade_required");
  cell.ownerCell = "user-reader";
  assert.equal(cell.admit("reader"), "admitted");
  assert.equal(cell.admit("intruder"), "foreign_cell");
  assert.equal(cell.admit("not a user"), "foreign_cell");
});

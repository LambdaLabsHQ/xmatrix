import assert from "node:assert/strict";
import { test } from "node:test";

import { RelayRuntimeLive } from "../src/relay-runtime.ts";
import { RelayPostgresAgentLaunchChannel } from "../src/postgres-agent-launch-channel-do.ts";
import { RelayPageSession } from "../src/page-session-do.ts";
import { RelayXUploadExecutor } from "../src/connectors/x-upload-executor-do.ts";
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
  runAsDeliveryInvocation,
  runAsRuntimeCell,
  runtimeDeliveryPlan,
  runtimeJsonRequest,
  RUNTIME_CHANNEL_MESSAGE_URL,
  RUNTIME_DELIVERY_INVOCATION_BUDGET,
} from "../src/runtime-transport/runtime-principal-delivery.ts";
import { createProductionRelayRuntimeProductPortFactory } from "../src/runtime-transport/production-product-port-factory.ts";
import { PostgresMachineDaemonPort } from "../src/runtime-transport/postgres-machine-daemon-port.ts";
import { PostgresMachineControlRepository, PostgresMachineLifecycleRepository, PostgresMessageRepository,
  PostgresSpaceControlRepository } from "@xmatrix/db";
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

test("a recalled message's tombstone reaches its reader and the Channel's Agent, each in their own cell", async () => {
  const reader = humanCell("reader", { focusedChannelId: "channel-1" });
  const agent = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) });
  const agentSocket = new FakeSocket();
  assert.equal(agent.rehydrate(agentSocket, agentInstanceAttachment()), true);
  const { env } = runtimeEnv(new Map([["user-reader", runtimeCell(reader.human)], ["user-user-1", runtimeCell(undefined, agent)]]));
  const tombstone = { ...message, body: "", deliveryKind: "update", entityVersion: 2, recalledAt: now };
  await publishChannelLiveDelivery(env, () => {}, "channel-1", tombstone, undefined,
    { recipientUserIds: ["reader"], recipientNotifications: [], instanceOwnerUserIds: ["user-1"] });
  assert.equal(received(reader.socket, "channel_message_updated"), 1);
  assert.equal(received(agentSocket, "channel_message_updated"), 1);
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

/** A Machine Daemon socket of owner-1's machine-1, back from hibernation. */
function daemonAttachment() {
  return { version: 1, domain: "machine_daemon", expiresAt: new Date(Date.now() + 60_000).toISOString(), session: {
    principal: { ownerUserId: "owner-1", ownerEmail: "owner-1@example.test", machineId: "machine-1", hostId: "host-1" },
    connectionEpoch: 1, displayName: "Workstation", clientVersion: "1.0.350", clientProtocolVersion: 2,
    capabilities: [], machineMetadata: {}, connectedAt: now, lastSeenAt: now } };
}

/** owner-1's cell, holding its Instance in channel-1 and, unless `machineOnline` is false, its daemon. */
function ownerCell({ machineOnline = true } = {}) {
  const agent = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) });
  assert.equal(agent.rehydrate(new FakeSocket(), agentInstanceAttachment({
    principal: { ownerUserId: "owner-1" },
    run: { channelInstanceId: "1", instanceStatus: "idle" },
    session: { presentation: { model: "gpt-5.6-sol", gitBranch: "fix/presence" } },
  })), true);
  const daemon = new MachineDaemonRuntimeTransport({ capabilities: new Set(MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES) });
  if (machineOnline) assert.equal(daemon.rehydrate(new FakeSocket(), daemonAttachment()), true);
  const cell = Object.create(RelayRuntimeLive.prototype);
  cell.productAdapter = new RelayRuntimeProductCallbackAdapter({ getWebSockets: () => [], acceptWebSocket() {} },
    new HumanRuntimeTransport({ capabilities: new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES) }), agent, daemon);
  return cell;
}

/** A Channel whose Agents are owned by `owners` (owner-1 owns agent-1/instance-1, and so on). */
function channelOwnedBy(owners) {
  return { id: "channel-1", spaceId: "space-1", name: "c", mode: "open", createdAt: now, updatedAt: now,
    memberPresence: Object.fromEntries(owners.map((owner, index) => [`agent-${index + 1}`, { kind: "agent", label: "Agent",
      registration: { ownerUserId: owner, machineId: "machine-1", harness: "codex" },
      instances: [{ id: `instance-${index + 1}`, channelId: "channel-1", channelInstanceId: String(index + 1), status: "idle",
        connectedAt: now, lastSeenAt: now }] }])) };
}

/**
 * viewer-1's socket in their own cell, focusing Channels whose owners' cells
 * answer as `cells` does; viewer-1 may read channel-1 only, and not even that unless `readable`.
 * `shown()` waits for what the last focus started.
 */
function viewerSocket(cells, { owners = ["owner-1"], readable = true } = {}) {
  const reads = [];
  const { env, calls } = runtimeEnv(cells);
  const factory = createProductionRelayRuntimeProductPortFactory(env, {
    readChannel: async (channelId, userId) => {
      reads.push([channelId, userId]);
      return readable && channelId === "channel-1" ? { openChannelHumanMemberIdsBySpace: {}, channel: channelOwnedBy(owners) } : undefined;
    },
    readHistory: async () => { throw new Error("unexpected history"); },
    analytics: { writeDataPoint() {} },
    runtimeSelf: { cellName: () => "user-viewer-1", fetch: () => { throw new Error("Unexpected self RPC"); } },
  });
  let started = Promise.resolve();
  const human = new HumanRuntimeTransport({ capabilities: new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES),
    focusChannel: async () => undefined, disconnected: async () => {} },
  { onChannelFocus: (input) => (started = factory.onChannelFocus(input)) });
  const socket = new FakeSocket();
  assert.equal(human.rehydrate(socket, { version: 1, domain: "human", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    session: { user: { id: "viewer-1", email: "viewer-1@example.test" }, connectedAt: now, lastSeenAt: now,
      focusedChannelId: null, deviceClient: "web", clientVersion: "1.8.0", clientProtocolVersion: 2 } }), true);
  return {
    socket, reads, cells: () => calls.map((call) => call.cell),
    focus: (channelId = "channel-1") => human.handleFrame(socket, JSON.stringify({ type: "user_focus_channel", requestId: `focus-${channelId}`, channelId })),
    ping: () => human.handleFrame(socket, JSON.stringify({ type: "ping", requestId: "ping" })),
    close: () => human.handleClose(socket, 1000, "closed", true),
    shown: () => started,
    cards: () => socket.sent.filter((frame) => frame.type === "enhanced_presence").map((frame) => frame.agent.instances[0]),
  };
}

async function openChannel(owner, options) {
  const viewer = viewerSocket(new Map([["user-owner-1", owner]]), options);
  await viewer.focus();
  await viewer.shown();
  return { cards: viewer.cards(), reads: viewer.reads, cells: viewer.cells() };
}

test("a person who opens a Channel is shown its Agents as they are now, from the cells that hold them", async () => {
  const opened = await openChannel(ownerCell());
  assert.deepEqual(opened.reads, [["channel-1", "viewer-1"]], "the read is the viewer's own authorization");
  assert.deepEqual(opened.cells, ["user-owner-1"]);
  assert.equal(opened.cards.length, 1);
  assert.equal(opened.cards[0].model, "gpt-5.6-sol");
  assert.equal(opened.cards[0].gitBranch, "fix/presence");
  assert.equal(opened.cards[0].status, "idle");

  const offline = (await openChannel(ownerCell({ machineOnline: false }))).cards[0];
  assert.deepEqual([offline.status, offline.offlineReason], ["offline", "machine_offline"],
    "the cell that knows the machine is down says so");

  const refused = await openChannel(ownerCell(), { readable: false });
  assert.deepEqual([refused.cards, refused.cells], [[], []], "nobody else's Agents for a Channel the person cannot read");
});

/** A cell that has not answered yet, by headers or by body, until `answer()`; `cancelled` once its body is. */
function stalledCell(stalledAt) {
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  const cell = {
    cancelled: false,
    answer: () => answer(),
    fetch: async () => {
      if (stalledAt === "fetch") { await answered; return Response.json({ sessions: [] }); }
      return new Response(new ReadableStream({
        start(controller) { void answered.then(() => {
          if (cell.cancelled) return;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ sessions: [] })));
          controller.close();
        }); },
        cancel() { cell.cancelled = true; },
      }));
    },
  };
  return cell;
}

for (const stalledAt of ["fetch", "body"]) {
  test(`a cell stalled at its ${stalledAt} holds back neither another owner's Agents nor the socket's next frame`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stalled = stalledCell(stalledAt);
    const viewer = viewerSocket(new Map([["user-owner-1", ownerCell()], ["user-owner-2", stalled]]),
      { owners: ["owner-1", "owner-2"] });
    await viewer.focus();
    await viewer.ping();
    assert.equal(viewer.socket.sent.filter((frame) => frame.type === "pong").length, 1, "the next frame is answered at once");
    for (let turn = 0; turn < 10 && viewer.cards().length === 0; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(viewer.cards().map((card) => card.id), ["instance-1"], "the owner that answered is shown");
    // Past its deadline the stalled read is given up, its body cancelled, and the focus is done.
    t.mock.timers.tick(1_000);
    await viewer.shown();
    assert.equal(stalled.cancelled, stalledAt === "body");
    stalled.answer();
    assert.deepEqual(viewer.cards().map((card) => card.id), ["instance-1"]);
  });
}

for (const moved of ["stays", "switches", "returns", "closes"]) {
  test(`a card read before the socket ${moved} reaches it only while that focus is its latest`, async () => {
    // owner-1's cell answers the first read late with the old branch, later reads at once with the new one.
    let answer;
    const answered = new Promise((resolve) => { answer = resolve; });
    let reads = 0;
    const live = (gitBranch) => Response.json({ sessions: [{ ownerUserId: "owner-1", agentId: "agent-1", agentName: "Agent",
      runId: "run-1", instanceId: "instance-1", channelId: "channel-1", channelInstanceId: "1", machineId: "machine-1",
      hostId: "host-1", status: "idle", connectedAt: now, lastSeenAt: now, presentation: { gitBranch } }] });
    const viewer = viewerSocket(new Map([["user-owner-1", { fetch: async () => {
      if (++reads > 1) return live("new-read");
      await answered;
      return live("old-read");
    } }]]));
    await viewer.focus("channel-1");
    const first = viewer.shown();
    if (moved === "switches" || moved === "returns") await viewer.focus("channel-2");
    if (moved === "returns") { await viewer.focus("channel-1"); await viewer.shown(); }
    if (moved === "closes") await viewer.close();
    answer();
    await first;
    await viewer.shown();
    const branches = viewer.cards().filter((card) => card.channelId === "channel-1").map((card) => card.gitBranch);
    assert.deepEqual(branches, moved === "stays" ? ["old-read"] : moved === "returns" ? ["new-read"] : []);
  });
}

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

const humanAttachment = (userId) => ({ version: 1, domain: "human", expiresAt: new Date(Date.now() + 60_000).toISOString(), session: {
  user: { id: userId, email: `${userId}@example.test` }, connectedAt: now, lastSeenAt: now, focusedChannelId: null,
  deviceClient: "web", clientVersion: "1.8.0", clientProtocolVersion: 2 } });
const ownerOnly = (ownerUserId) => ownerUserId === "owner" ? "admitted" : "foreign_cell";

test("a Human socket back from hibernation in a cell not theirs is closed unserved: a frame it had queued does nothing", async () => {
  const executed = [];
  const transport = new HumanRuntimeTransport({ capabilities: new Set(HUMAN_AUTHORITY_REQUIRED_CAPABILITIES),
    async focusChannel(session) { executed.push(session.user.id); }, async disconnected() {} }, { admit: ownerOnly });
  const foreign = new FakeSocket();
  const own = new FakeSocket();
  assert.equal(transport.rehydrate(foreign, humanAttachment("stranger")), true);
  assert.equal(transport.rehydrate(own, humanAttachment("owner")), true);
  assert.deepEqual(foreign.closed, [{ code: 1008, reason: "Runtime cell is not this account's" }]);
  assert.equal(transport.session(foreign), undefined);
  assert.deepEqual(transport.liveSessions().map((session) => session.userId), ["owner"]);
  await transport.handleFrame(foreign, JSON.stringify({ type: "user_focus_channel", requestId: "queued", channelId: "channel-1" }));
  await transport.handleFrame(own, JSON.stringify({ type: "user_focus_channel", requestId: "control", channelId: "channel-1" }));
  assert.deepEqual(executed, ["owner"]);
});

test("an Agent Instance back from hibernation in a cell not its owner's is closed before it binds or counts as live", () => {
  const bound = [];
  const transport = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
    connected(session) { bound.push(session.run.instanceId); } },
  undefined, undefined, undefined, false, ownerOnly);
  const foreign = new FakeSocket();
  const own = new FakeSocket();
  assert.equal(transport.rehydrate(foreign, agentInstanceAttachment({ principal: { ownerUserId: "stranger" },
    run: { instanceId: "foreign-instance" } })), true);
  assert.equal(transport.rehydrate(own, agentInstanceAttachment({ principal: { ownerUserId: "owner", runId: "own-run" },
    run: { instanceId: "own-instance" } })), true);
  assert.deepEqual(foreign.closed, [{ code: 1008, reason: "Runtime cell is not this account's" }]);
  assert.deepEqual(transport.liveSessions().map((session) => session.principal.ownerUserId), ["owner"]);
  assert.deepEqual(bound, ["own-instance"], "only the admitted Instance is bound for live delivery");
});

test("a Machine Daemon back from hibernation in a cell not its owner's takes no route", () => {
  const transport = new MachineDaemonRuntimeTransport({ capabilities: new Set(MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() { throw new Error("not used"); }, async refresh() { throw new Error("not used"); },
    async execute() {}, async disconnected() {} }, false, undefined, undefined, ownerOnly);
  const socket = new FakeSocket();
  assert.equal(transport.rehydrate(socket, { version: 1, domain: "machine_daemon", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    session: { principal: { ownerUserId: "stranger", ownerEmail: "stranger@example.test", machineId: "machine-1", hostId: "host-1" },
      connectionEpoch: 1, displayName: "Laptop", clientVersion: "1.8.0", clientProtocolVersion: 2, capabilities: [],
      machineMetadata: {}, lastSeenAt: now, connectedAt: now } }), true);
  assert.deepEqual(socket.closed, [{ code: 1008, reason: "Runtime cell is not this account's" }]);
  assert.equal(transport.session(socket), undefined);
  assert.equal(transport.isRouteReachable({ ownerUserId: "stranger", machineId: "machine-1", hostId: "host-1" }), false);
});

test("a cell admits only its owner's sockets, and the single cell admits none", () => {
  const cell = Object.create(RelayRuntimeLive.prototype);
  assert.equal(cell.admit("reader"), "upgrade_required");
  cell.ownerCell = "user-reader";
  assert.equal(cell.admit("reader"), "admitted");
  assert.equal(cell.admit("intruder"), "foreign_cell");
  assert.equal(cell.admit("not a user"), "foreign_cell");
});

/** A namespace that answers every cell, recording which were fetched. */
function answeringEnv(calls = []) {
  return { calls, env: { RELAY_RUNTIME: recordingRuntimeNamespace(calls, async () => Response.json({})) } };
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
const anyRequest = () => runtimeJsonRequest(RUNTIME_CHANNEL_MESSAGE_URL, {});

test("work of one cell publishes from that cell, interleaved with another's, nested, after a throw, or later", async () => {
  const { env, calls } = answeringEnv();
  const served = [];
  const cell = (name) => ({ cellName: `user-${name}`, fetch: async () => { served.push(name); return Response.json({}); } });
  const publish = () => deliverToAudience({ env, audience: { humans: ["alice", "bob"] }, label: "test", request: anyRequest });
  await Promise.all([
    runAsRuntimeCell(cell("alice"), async () => { await pause(); await publish(); }),
    runAsRuntimeCell(cell("bob"), async () => { await publish(); await pause(); }),
  ]);
  assert.deepEqual(served.sort(), ["alice", "bob"]);
  assert.deepEqual(calls.map((call) => call.cell).sort(), ["user-alice", "user-bob"]);
  served.length = 0;
  calls.length = 0;
  // A later callback started inside the cell's work is still its work; outside it, nobody's.
  let later;
  await runAsRuntimeCell(cell("alice"), async () => {
    later = new Promise((resolve) => setTimeout(() => resolve(publish()), 5));
  });
  await later;
  await assert.rejects(runAsRuntimeCell(cell("bob"), async () => { throw new Error("handler failed"); }));
  await publish();
  assert.deepEqual(served, ["alice"]);
  assert.deepEqual(calls.map((call) => call.cell).sort(), ["user-alice", "user-bob", "user-bob"]);
});

test("one invocation's deliveries share one budget: retries spend it, the cell's own share and nested work do not reset it", async () => {
  const { env, calls } = answeringEnv();
  const humans = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  await runAsDeliveryInvocation(async () => {
    await deliverToAudience({ env, audience: { humans: humans(RUNTIME_DELIVERY_INVOCATION_BUDGET - 2, "first") },
      label: "first", request: anyRequest });
    const self = { cellName: "user-own", fetch: async () => Response.json({}) };
    // The cell's own share costs nothing; two other cells are what is left.
    await runAsRuntimeCell(self, () => deliverToAudience({ env, audience: { humans: ["own", ...humans(4, "second")] },
      label: "second", request: anyRequest }))
      .then(() => assert.fail("the budget must run out"), (error) => {
        assert.equal(error.name, "RuntimeDeliveryError");
        assert.match(error.message, /unreached=2 of=5 delivery=second/u);
      });
  });
  assert.equal(calls.length, RUNTIME_DELIVERY_INVOCATION_BUDGET);
  // A new invocation has a new budget.
  await runAsDeliveryInvocation(() => deliverToAudience({ env, audience: { humans: ["fresh"] }, label: "next", request: anyRequest }));
  assert.equal(calls.at(-1).cell, "user-fresh");
});

/**
 * A pass that publishes to every cell but one the budget allows, then to two
 * more: one invocation reaches exactly the budget and reports the rest.
 */
function passOverBudget() {
  const { env, calls } = answeringEnv();
  const readers = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  const publish = (humans) => deliverToAudience({ env, audience: { humans }, label: "pass", request: anyRequest });
  return { calls, run: async () => {
    await publish(readers(RUNTIME_DELIVERY_INVOCATION_BUDGET - 1, "first"));
    await publish(["last", "over"]);
  } };
}

async function spendsOneBudget(entry, inject) {
  const pass = passOverBudget();
  let failure;
  await entry(inject(() => pass.run().catch((error) => { failure = error; })));
  assert.equal(pass.calls.length, RUNTIME_DELIVERY_INVOCATION_BUDGET);
  assert.equal(failure?.name, "RuntimeDeliveryError");
}

test("each event of an object that publishes and is not a Runtime cell spends one budget", async () => {
  const coordinator = () => {
    const object = Object.create(RelayPostgresAgentLaunchChannel.prototype);
    const values = new Map();
    object.state = { storage: { get: async (key) => values.get(key), put: async (key, value) => { values.set(key, value); },
      setAlarm: async () => {} } };
    return object;
  };
  await spendsOneBudget((object) => object.alarm(), (run) => Object.assign(coordinator(), { lanes: { claim: run } }));
  let pending;
  await spendsOneBudget(async (object) => {
    const response = await object.fetch(new Request("https://coordinator/wake", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId: "channel" }) }));
    assert.equal(response.status, 200);
    await pending;
  }, (run) => Object.assign(coordinator(), { lanes: { claim: () => (pending = run()) } }));

  const uploads = (run) => Object.assign(Object.create(RelayXUploadExecutor.prototype), { executor: { alarm: run, enqueue: run } });
  await spendsOneBudget((object) => object.alarm(), uploads);
  await spendsOneBudget((object) => object.enqueue({}), uploads);

  const page = (handler, run) => Object.assign(Object.create(RelayPageSession.prototype), { [handler]: run });
  await spendsOneBudget((object) => object.alarm(), (run) => page("onAlarm", run));
  await spendsOneBudget((object) => object.webSocketMessage({}, new ArrayBuffer(0)), (run) => page("onSocketMessage", run));
  await spendsOneBudget((object) => object.webSocketClose({}), (run) => page("onSocketClose", run));
  await spendsOneBudget((object) => object.webSocketError({}), (run) => page("onSocketClose", run));
  await spendsOneBudget((object) => object.fetch(new Request("https://page/")), (run) => page("onRequest", run));
});

test("a Machine Daemon's completion report tells its owner locally and every other reader in their own cell", async (t) => {
  t.mock.method(PostgresMachineControlRepository.prototype, "command", async () => ({}));
  t.mock.method(PostgresMachineLifecycleRepository.prototype, "apply", async () => ({ changedRunIds: ["run"] }));
  t.mock.method(PostgresSpaceControlRepository.prototype, "resolveChannelSpaceId", async () => "space");
  t.mock.method(PostgresMessageRepository.prototype, "liveRecipientUserIds", async () => ["owner", "reader"]);
  const calls = [];
  const local = [];
  const env = {
    RELAY_POSTGRES: { connectionString: "postgres://authority.invalid/xmatrix" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_RUNTIME: recordingRuntimeNamespace(calls, async () => Response.json({ delivered: 1 })),
  };
  const factory = createProductionRelayRuntimeProductPortFactory(env, {
    runtimeSelf: { cellName: () => "user-owner", fetch: async (request) => { local.push(new URL(request.url).pathname); return Response.json({ delivered: 1 }); } },
  });
  const reply = await factory.machineDaemon().execute({
    principal: { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine", hostId: "host" },
    connectionEpoch: 1, capabilities: [],
  }, { type: "machine_spawn_result", requestId: "spawn", runId: "run", channelId: "channel", ok: true, spawnedAt: now });
  assert.equal(reply.type, "machine_command_completion_acked");
  assert.deepEqual(local, ["/internal/product/channel-observable-event"]);
  assert.deepEqual(calls.map((call) => call.cell), ["user-reader"]);
});

test("a daemon connect refused for another owner's cell advances no epoch and wakes nothing; its own cell connects as before", async () => {
  const principal = { ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine-1", hostId: "host-1" };
  const commands = [];
  const woken = [];
  const port = new PostgresMachineDaemonPort({
    authenticate: async () => principal,
    daemonCommand: async (input) => {
      commands.push(input.action);
      return { connectionEpoch: commands.length, daemon: { id: "machine-1-daemon", userId: "owner",
        email: principal.ownerEmail, machineId: "machine-1", name: "Laptop", status: "online",
        connectedAt: now, lastSeenAt: now } };
    },
    runLifecycleReport: async () => ({}),
    launchUpdate: async () => undefined,
    machineConnected: async (route) => { woken.push(route.machineId); },
  });
  const connect = async (admission) => {
    const transport = new MachineDaemonRuntimeTransport(port, false, undefined, undefined, () => admission);
    const socket = new FakeSocket();
    transport.accept(socket);
    await transport.handleFrame(socket, machineDaemonConnectFrame(principal));
    return { transport, socket };
  };
  for (const admission of ["foreign_cell", "upgrade_required"]) {
    const { transport, socket } = await connect(admission);
    assert.equal(transport.session(socket), undefined, admission);
  }
  assert.deepEqual(commands, [], "a refused connect commits nothing");
  assert.deepEqual(woken, [], "a refused connect wakes nothing");
  const { transport, socket } = await connect("admitted");
  assert.equal(transport.session(socket)?.connectionEpoch, 1);
  assert.equal(commands[0], "connect", "the admitted connect is the first command committed");
  assert.deepEqual(woken, ["machine-1"]);
});

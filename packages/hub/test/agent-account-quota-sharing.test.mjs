import assert from "node:assert/strict";
import { test } from "node:test";
import { withRegistrationQuota } from "@xmatrix/protocol";
import { projectRegistrationQuota } from "../src/registration-quota-presentation.ts";
import { overlayChannelsWithLiveAgentPresence } from "../src/runtime-transport/agent-presence-snapshot.ts";
import { createProductionRelayRuntimeProductPortFactory } from "../src/runtime-transport/production-product-port-factory.ts";
import { AgentInstanceRuntimeTransport } from "../src/runtime-transport/agent-instance-port.ts";

const now = new Date().toISOString();
const key = { ownerUserId: "owner", machineId: "machine", harness: "claude" };
const quota = percent => ({ quotaSource: "provider_api", quotaObservedAt: now, quotaUsages: [{ label: "5h", percent }] });
function channel(id, registration = key) {
  return { id, spaceId: "space", name: id, mode: "open", createdAt: now, updatedAt: now,
    memberPresence: { [id]: { kind: "agent", registration, instances: [{ id, status: "idle",
      channelInstanceId: "1", connectedAt: now, lastSeenAt: now, usage: { totalTokens: 7, ...quota(99) } }] } } };
}
function snapshot(id) {
  return { ownerUserId: "owner", agentId: id, instanceId: id, agentName: "claude", runId: `run-${id}`,
    channelId: id, channelInstanceId: "1", machineId: "machine", hostId: "host", status: "idle",
    connectedAt: now, lastSeenAt: now, presentation: { usage: { totalTokens: 3, ...quota(99) } } };
}

test("different Channel identities read one tuple quota; stale samples cannot replace it", async () => {
  const channels = [channel("a"), channel("b"), channel("c", { ...key, ownerUserId: "other" }),
    channel("d", { ...key, machineId: "other" }), channel("e", { ...key, harness: "codex" })];
  const database = { transaction: async (_context, callback) => callback({ query: async statement => {
    assert.equal(JSON.parse(statement.values[0]).length, 4, "same tuple is read once");
    return [{ owner_user_id: "owner", machine_id: "machine", harness: "claude", remaining: 88,
      observed_at: now, expires_at: new Date(Date.now() + 60_000).toISOString(), windows_json: [{ label: "5h", usedPercent: 12 }] }];
  } }) };
  await projectRegistrationQuota(database, channels, "read");
  const projected = overlayChannelsWithLiveAgentPresence(channels, channels.map(c => snapshot(c.id)));
  for (const c of projected.slice(0, 2)) {
    assert.equal(c.memberPresence[c.id].usage.quotaUsages[0].percent, 12);
    assert.equal(c.memberPresence[c.id].instances[0].usage.totalTokens, 3);
    assert.equal(c.memberPresence[c.id].usage.quotaObservedAt, now);
  }
  for (const c of projected.slice(2)) assert.equal(c.memberPresence[c.id].usage.quotaUsages, undefined);
});

class Socket { readyState = 1; send() {} close() {} }
function fixture() {
  const channels = { a: channel("a"), b: channel("b", { ...key, machineId: "another-machine" }), sleeping: channel("sleeping") };
  for (const c of Object.values(channels)) c.memberPresence[c.id].usage = quota(12);
  const readings = { owner: [{ registration: key, usage: quota(12) },
    { registration: { ...key, machineId: "another-machine" }, usage: quota(12) }] };
  const channelReads = [], quotaReads = [];
  const pool = { usage: quota(12) };
  const factory = createProductionRelayRuntimeProductPortFactory({}, {
    readChannel: async (channelId) => {
      channelReads.push(channelId);
      return { channel: channels[channelId], openChannelHumanMemberIdsBySpace: { space: ["user:owner", "user:viewer"] } };
    },
    readOwnerQuota: async ownerUserId => readings[ownerUserId] ?? [],
    readQuota: async registration => { quotaReads.push(registration); return pool.usage; },
    analytics: { writeDataPoint() {} }, readHistory: async () => { throw Error("unexpected history"); } });
  const transport = new AgentInstanceRuntimeTransport(factory.agentInstance());
  const sessions = ["a", "b"].map(id => ({ principal: { ownerUserId: "owner", agentId: id,
    agentName: "claude", spaceId: "space", runId: `run-${id}`, executionKey: id, channelId: id,
    machineId: id === "b" ? "another-machine" : "machine", hostId: "host" }, run: { runId: `run-${id}`, agentId: id, instanceId: id,
    executionKey: id, channelId: id, channelInstanceId: "1", machineId: id === "b" ? "another-machine" : "machine", hostId: "host",
    status: "running", instanceStatus: "idle" }, connectedAt: now, lastSeenAt: now,
    presentation: { usage: quota(99) }, clientVersion: "0.16.705", clientProtocolVersion: 2 }));
  for (const session of sessions) assert.equal(transport.rehydrate(new Socket(), { version: 1, domain: "agent_instance",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), session }), true);
  return { factory, sessions, channels, readings, channelReads, quotaReads, pool };
}

/** Records both immediate frames and a presence digest's card and Channel as one list. */
function recordDelivered(frames) {
  return {
    deliver: (userId, frame) => frames.push({ userId, frame }),
    deliverAgentPresence: (userId, _channelId, card, channel) => {
      if (card) frames.push({ userId, frame: card });
      if (channel) frames.push({ userId, frame: channel });
    },
  };
}

const quotaFrames = frames => frames.filter(({ frame }) => frame.type === "registration_quota");

/** The fixture, with one presence change of its first Instance recorded per call. */
function reporting() {
  const context = fixture(), frames = [];
  const report = (reason = "update") => context.factory.onAgentPresenceChange({ reason, session: context.sessions[0],
    liveHumanSessions: [], ...recordDelivered(frames) });
  return { ...context, frames, report };
}

test("an Instance update sends its registration's reading to the owner once, reading no other Channel", async () => {
  const { factory, sessions, channelReads } = fixture(), frames = [];
  await factory.onAgentPresenceChange({ reason: "update", session: sessions[0], liveHumanSessions: [],
    ...recordDelivered(frames) });
  assert.deepEqual(channelReads, ["a"]);
  assert.deepEqual(quotaFrames(frames).map(({ userId, frame }) => [userId, frame.registration]), [["owner", key]]);
  assert.equal(quotaFrames(frames)[0].frame.usage.quotaUsages[0].percent, 12);
  assert.equal(quotaFrames(frames)[0].frame.usage.totalTokens, undefined, "no Instance counters in a pool reading");
  assert.equal(frames.find(({ frame }) => frame.type === "enhanced_presence").frame.agent.usage.quotaUsages[0].percent, 12);
  frames.length = 0;
  await factory.onAgentPresenceChange({ reason: "update", session: sessions[0], liveHumanSessions: [],
    ...recordDelivered(frames) });
  assert.deepEqual(quotaFrames(frames), [], "an unchanged reading is not sent again");
});

test("a daemon probe sends the owner each changed registration reading from one read", async () => {
  const { factory, readings, channelReads } = fixture(), frames = [];
  const deliver = (userId, frame) => frames.push({ userId, frame });
  await factory.onRegistrationQuotaChange({ ownerUserId: "owner", deliver });
  assert.deepEqual(quotaFrames(frames).map(({ userId, frame }) => [userId, frame.registration.machineId]),
    [["owner", "machine"], ["owner", "another-machine"]]);
  assert.deepEqual(channelReads, []);
  frames.length = 0;
  readings.owner[1] = { ...readings.owner[1], usage: quota(40) };
  await factory.onRegistrationQuotaChange({ ownerUserId: "owner", deliver });
  assert.deepEqual(quotaFrames(frames).map(({ frame }) => [frame.registration.machineId, frame.usage.quotaUsages[0].percent]),
    [["another-machine", 40]]);
  frames.length = 0;
  await factory.onRegistrationQuotaChange({ ownerUserId: "other-owner", deliver });
  assert.deepEqual(frames, []);
});

test("a failed probe read sends nothing and does not throw", async () => {
  const frames = [];
  const factory = createProductionRelayRuntimeProductPortFactory({}, {
    readChannel: async () => undefined,
    readOwnerQuota: async () => { throw new Error("PostgreSQL unavailable"); },
    analytics: { writeDataPoint() {} }, readHistory: async () => { throw Error("unexpected history"); } });
  await factory.onRegistrationQuotaChange({ ownerUserId: "owner", deliver: (userId, frame) => frames.push({ userId, frame }) });
  assert.deepEqual(frames, []);
});

test("pool projection never imports another Instance's token or context counters", () => {
  const usage = withRegistrationQuota({ totalTokens: 7, contextUsedTokens: 3 },
    { ...quota(12), totalTokens: 999, contextUsedTokens: 888 });
  assert.equal(usage.totalTokens, 7);
  assert.equal(usage.contextUsedTokens, 3);
  assert.equal(usage.quotaUsages[0].percent, 12);
});

test("explicit unknown projections withdraw cached quota without removing counters", () => {
  const usage = withRegistrationQuota({ totalTokens: 7, ...quota(99) }, { quotaState: "unknown", quotaObservedAt: now });
  assert.equal(usage.quotaState, "unknown");
  assert.equal(usage.quotaSource, undefined);
  assert.equal(usage.quotaUsages, undefined);
  assert.equal(usage.totalTokens, 7);
});

test("usage-limit holds reach catalog and member presentation without a fabricated window", async () => {
  const channels = [channel("held")];
  const database = { transaction: async (_context, callback) => callback({ query: async () => [{
    owner_user_id: "owner", machine_id: "machine", harness: "claude", remaining: 0,
    observed_at: now, expires_at: new Date(Date.now() + 60_000).toISOString(), windows_json: null,
  }] }) };
  await projectRegistrationQuota(database, channels, "held-read");
  const [live] = overlayChannelsWithLiveAgentPresence(channels, [snapshot("held")]);
  assert.equal(live.memberPresence.held.usage.quotaState, "exhausted");
  assert.equal(live.memberPresence.held.instances[0].usage.quotaState, "exhausted");
  assert.equal(live.memberPresence.held.usage.quotaUsages[0].label, undefined);
});

test("local accounting changes do not send an unchanged pool observation", async () => {
  const { sessions, quotaReads, pool, frames, report: publish } = reporting();
  await publish();
  frames.length = 0;
  sessions[0].presentation.usage = { ...quota(99), totalTokens: 2, contextUsedTokens: 1 };
  await publish();
  assert.deepEqual(quotaFrames(frames), []);
  assert.deepEqual(quotaReads, [], "a reading the Instance already reported is not read again");
  assert.equal(frames.find(({ frame }) => frame.type === "enhanced_presence").frame.agent.usage.totalTokens, 2);
  frames.length = 0;
  // The Instance reports a newer provider reading: its pool is read once, and the new version reaches the owner.
  const later = new Date(Date.parse(now) + 1).toISOString();
  pool.usage = { ...quota(30), quotaObservedAt: later };
  sessions[0].presentation.usage = { ...quota(30), quotaObservedAt: later };
  await publish();
  await publish();
  assert.deepEqual(quotaReads, [key]);
  assert.equal(quotaFrames(frames).length, 1, "a new quota version still reaches the owner's other Agents");
  assert.equal(frames.filter(({ frame }) => frame.type === "enhanced_presence")
    .every(({ frame }) => frame.agent.usage.quotaUsages[0].percent === 30), true);
});

test("a status report after the Channel was read reads nothing and sends only the card", async () => {
  const { channelReads, frames, report } = reporting();
  await report("connect");
  assert.deepEqual(channelReads, ["a"]);
  frames.length = 0;
  await report("update");
  assert.deepEqual(channelReads, ["a"], "a status report reads no Channel");
  assert.deepEqual(frames.map(({ userId, frame }) => [userId, frame.type]),
    [["owner", "enhanced_presence"], ["viewer", "enhanced_presence"]]);
});

test("a catalog change in the Space, or leaving, reads the Channel again", async () => {
  const { factory, channelReads, frames, report } = reporting();
  await report("connect");
  factory.onChannelCatalogChanged("another-space");
  await report("update");
  assert.deepEqual(channelReads, ["a"], "another Space's catalog says nothing about this Channel");
  factory.onChannelCatalogChanged("space");
  await report("update");
  assert.deepEqual(channelReads, ["a", "a"]);
  assert.ok(frames.some(({ userId, frame }) => userId === "viewer" && frame.type === "channel_updated"));
  await report("disconnect");
  await report("update");
  assert.deepEqual(channelReads, ["a", "a", "a", "a"], "after leaving, a report reads the Channel again");
});

test("a status report goes through presence delivery, with no presence_updated event", async () => {
  const { factory, sessions } = fixture(), immediate = [], presence = [];
  await factory.onAgentPresenceChange({ reason: "update", session: sessions[0], liveHumanSessions: [],
    deliver: (userId, frame) => immediate.push({ userId, frame }),
    deliverAgentPresence: (userId, channelId, card, channel) => presence.push({ userId, channelId, card, channel }) });
  assert.ok(presence.length > 0);
  assert.ok(presence.every(({ channelId }) => channelId === "a"));
  assert.ok(presence.some(({ card }) => card?.type === "enhanced_presence"));
  assert.equal(immediate.some(({ frame }) => frame.type === "observable_event"), false,
    "presence_updated events are not sent");
  assert.equal(immediate.some(({ frame }) => frame.type === "channel_updated" && frame.channel?.id === "a"), false,
    "the reporting Channel goes only through presence delivery");
});

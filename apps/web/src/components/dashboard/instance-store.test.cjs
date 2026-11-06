const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { decodeChannelSnapshot, channelPresenceInstances } = require("@xmatrix/protocol");
const { createRealtimeChannels } = require("./instance-store.ts");
const { buildAgentWorkItems } = require("./workspace-shell-recovered.tsx");
const registration = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
const record = (version, sequence, extra = {}) => ({ id: "channel:1", channelId: "channel", channelInstanceId: "1",
  label: "codex:1", agentName: "codex", registration, status: "busy", connectedAt: "2026-11-06T18:00:00Z",
  lastSeenAt: "2026-11-06T18:00:01Z", revision: { version, sequence }, ...extra });
const window = (records = []) => decodeChannelSnapshot({ id: "channel", name: "Channel", instanceRecords: records,
  memberPresence: {} });

// The original incident's owner boundary: a report must be self-sufficient,
// and a late catalog window cannot remove it. The old Channel-only store has
// neither contract and needed a connect snapshot followed by a repair read.
test("one record places a new Instance, surviving late and empty catalog windows without catalog promotion", () => {
  const store = createRealtimeChannels([window()]);
  const catalog = store.getCatalogSnapshot();
  let own = 0, other = 0;
  store.subscribeKey("channel", () => own++);
  store.subscribeKey("other", () => other++);
  store.instances.receive([record(2, 7)]);
  assert.equal(channelPresenceInstances(store.get("channel").presence).length, 1);
  assert.equal(store.getCatalogSnapshot(), catalog, "streaming state does not rewrite message/list metadata");
  store.receive([window([record(2, 0, { status: "idle" })])]);
  store.set([window()]);
  assert.equal(store.get("channel").presence.instances.get("channel:1").status, "busy");
  assert.equal(other, 0);
  assert.ok(own > 0);
});

test("explicit terminal records leave the dock but stay available to exact sender lookup and fence old reports", () => {
  const store = createRealtimeChannels([window([record(2, 7)])]);
  store.instances.receive([record(3, 0, { status: "offline" })]);
  store.instances.receive([record(2, 999, { status: "busy", lastSeenAt: "2099-01-01T00:00:00Z" })]);
  const channel = store.get("channel");
  assert.deepEqual(buildAgentWorkItems(channel, []), []);
  assert.equal(channel.presence.instances.get("channel:1").status, "offline");
  store.instances.receive([record(4, 1, { status: "idle" })]);
  assert.equal(channelPresenceInstances(store.get("channel").presence)[0].status, "idle");
});

test("only exact misses delete held facts, fenced against a newer report during the read; access removal clears its facts", () => {
  const store = createRealtimeChannels([window([record(2, 7)])]);
  const asked = new Map([["channel:1", store.instances.get("channel:1")]]);
  store.instances.receive([record(2, 8)]);
  store.instances.reconcileMissing(["channel:1"], asked);
  assert.equal(store.instances.get("channel:1").revision.sequence, 8);
  store.instances.reconcileMissing(["channel:1"], new Map([["channel:1", store.instances.get("channel:1")]]));
  assert.equal(store.instances.get("channel:1"), undefined);
  store.instances.receive([record(3, 0)]);
  store.set([]);
  assert.equal(store.instances.get("channel:1"), undefined);
});

test("temporary activity never establishes residency, cannot change status and ends with its lifecycle", () => {
  const store = createRealtimeChannels([window()]);
  const activity = (version, sequence, intent) => ({ instanceId: "channel:1", channelId: "channel",
    revision: { version, sequence }, intent });
  store.instances.receiveActivity([activity(2, 1, "Unknown work")]);
  assert.deepEqual(channelPresenceInstances(store.get("channel").presence), []);
  store.instances.receive([record(2, 4)]);
  store.instances.receiveActivity([activity(2, 6, "Current work")]);
  store.instances.receiveActivity([activity(2, 5, "Old work")]);
  assert.equal(store.get("channel").presence.instances.get("channel:1").intent, "Current work");
  assert.equal(store.get("channel").presence.instances.get("channel:1").status, "busy");
  store.instances.receive([record(2, 7, { status: "idle" })]);
  store.instances.receiveActivity([activity(2, 6, "Late previous turn")]);
  assert.equal(store.get("channel").presence.instances.get("channel:1").intent, undefined,
    "a newer durable checkpoint fences older work even within the same connection");
  store.instances.receive([record(3, 0, { status: "offline" })]);
  store.instances.receiveActivity([activity(2, 999, "Late old work")]);
  assert.equal(store.get("channel").presence.instances.get("channel:1").intent, undefined);
  store.instances.receive([record(4, 1, { status: "idle" })]);
  assert.equal(store.get("channel").presence.instances.get("channel:1").intent, undefined);
});

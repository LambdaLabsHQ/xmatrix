import assert from "node:assert/strict";
import test from "node:test";
import { ChannelPresenceConflict, channelPresenceInstances, decodeChannelSnapshot, encodeChannelSnapshot,
  presenceInstanceId, reduceChannelPresence } from "../dist/index.js";

const at = "2026-10-16T07:00:00Z";
const instance = (id, slot, extra = {}) => ({ id, channelInstanceId: slot, channelId: "channel",
  connectedAt: at, lastSeenAt: at, status: "online", ...extra });
const wire = members => ({ id: "channel", memberPresence: members });
const member = instances => ({ registration: { ownerUserId: "owner-1", machineId: "machine-1", harness: "claude" }, kind: "agent", label: "Claude", avatarUrl: "/claude.svg", instances });

test("legacy grouped Instances decode once without copying a sibling's aggregate Run state", () => {
  const channel = decodeChannelSnapshot(wire({ principal: { ...member([
    instance("a", "1", { activity: "A's work" }), instance("b", "2"),
  ]), activity: "A's work", intent: "PRIVATE_TO_A", files: ["a.ts"], runtimeState: { status: "running" },
  lastSeenAt: "2026-10-16T08:00:00Z", usage: { totalTokens: 99 } } }));
  assert.equal("memberPresence" in channel, false);
  const entries = channelPresenceInstances(channel.presence);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].activity, undefined);
  assert.equal(entries[1].intent, undefined);
  assert.equal(entries[1].runtimeState, undefined);
  assert.equal(entries[1].usage, undefined);
  assert.equal(entries[1].lastSeenAt, at);
  assert.equal("avatarUrl" in entries[1], false);
  assert.equal(encodeChannelSnapshot(channel).memberPresence.b.avatarUrl, "/agent-vendors/claude.svg");
});

test("canonical Instance entry wins over a cached sender alias in either input order", () => {
  const canonical = ["a", member([instance("a", "1")])];
  const alias = ["agent:a", { ...member([instance("a", "1")]), avatarUrl: undefined }];
  for (const entries of [[alias, canonical], [canonical, alias]]) {
    const decoded = decodeChannelSnapshot(wire(Object.fromEntries(entries)));
    assert.equal(decoded.presence.instances.size, 1);
    assert.equal(encodeChannelSnapshot(decoded).memberPresence.a.avatarUrl, "/agent-vendors/claude.svg");
    assert.deepEqual(Object.keys(encodeChannelSnapshot(decoded).memberPresence), ["a"]);
  }
});

test("unknown and removed Instances cannot be resurrected by message patches", () => {
  const channel = decodeChannelSnapshot(wire({ a: member([instance("a", "1")]) }));
  const state = channel.presence;
  assert.equal(reduceChannelPresence(state, { type: "patch_known", instanceId: presenceInstanceId("unknown"), patch: { status: "busy" } }), state);
  const removed = reduceChannelPresence(state, { type: "remove", instanceId: presenceInstanceId("a") });
  assert.equal(reduceChannelPresence(removed, { type: "patch_known", instanceId: presenceInstanceId("a"), patch: { status: "busy" } }), removed);
  assert.equal(removed.instances.size, 0);
});

test("reborn updates the same Instance; a partial frame cannot transfer its slot to another identity", () => {
  const state = decodeChannelSnapshot(wire({ a: member([instance("a", "1")]) })).presence;
  const first = state.instances.get(presenceInstanceId("a"));
  const reborn = reduceChannelPresence(state, { type: "upsert", instance: { ...first, status: "busy" } });
  assert.equal(reborn.instances.size, 1);
  assert.equal(reborn.instances.get(first.id).connectedAt, at);
  assert.throws(() => reduceChannelPresence(reborn, { type: "upsert", instance: { ...first, id: presenceInstanceId("different") } }), ChannelPresenceConflict);
  const replaced = decodeChannelSnapshot(wire({ different: member([instance("different", "1")]) }));
  assert.deepEqual([...replaced.presence.instances.keys()], ["different"]);
});

test("only an exact Instance identity can remove a row", () => {
  const state = decodeChannelSnapshot(wire({ a: member([instance("a", "1")]) })).presence;
  assert.throws(() => reduceChannelPresence(state, { type: "remove", channelInstanceId: "1" }), TypeError);
  assert.equal(state.instances.size, 1);
});

test("partial upsert retains siblings; an explicit complete empty snapshot clears them", () => {
  const state = decodeChannelSnapshot(wire({ sameName: member([instance("a", "1"), instance("b", "2")]) })).presence;
  const updated = reduceChannelPresence(state, { type: "patch_known", instanceId: presenceInstanceId("a"), patch: { status: "busy" } });
  assert.equal(updated.instances.size, 2);
  assert.equal(updated.instances.get(presenceInstanceId("b")), state.instances.get(presenceInstanceId("b")));
  assert.equal(decodeChannelSnapshot(wire({})).presence.instances.size, 0);
  assert.equal(decodeChannelSnapshot({ id: "channel" }).presence, undefined);
});

test("Human devices have their own collection and never enter the Instance map", () => {
  const channel = decodeChannelSnapshot(wire({ "user:human": { kind: "user", status: "online", instances: [instance("device", undefined)] },
    a: member([instance("a", "1")]) }));
  assert.equal(channel.presence.humans.get("user:human").devices.length, 1);
  assert.equal(channel.presence.instances.size, 1);
  assert.equal(channel.presence.instances.has(presenceInstanceId("device")), false);
});

test("all views share birth order and daemon exclusion", () => {
  const decoded = decodeChannelSnapshot(wire({ later: member([instance("b", "2", { connectedAt: "2026-10-16T08:00:00Z" })]),
    first: member([instance("a", "1")]), daemon: { ...member([instance("daemon", "3")]), label: "xmatrix-daemon-host" } }));
  assert.deepEqual(channelPresenceInstances(decoded.presence).map(entry => entry.id), ["a", "b"]);
});

test("a missing registration or conflicting authoritative row is isolated from the rest of a catalog page", async t => {
  t.mock.method(console, "error", () => {});
  const { decodeChannelCatalogPage } = await import("../dist/index.js");
  const bad = wire({ a: member([instance("a", "1"), instance("b", "1")]) });
  const unbound = wire({ a: { ...member([instance("a", "1")]), registration: undefined } });
  const page = decodeChannelCatalogPage({ rows: [{ channel: bad }, { channel: unbound },
    { channel: wire({ a: member([instance("a", "1")]) }) }] });
  assert.equal(page.rows.length, 3);
  assert.equal(page.rows[0].channel.presence, undefined);
  assert.equal(page.rows[1].channel.presence, undefined);
  assert.equal(page.rows[2].channel.presence.instances.size, 1);
  assert.equal(console.error.mock.callCount(), 2);
});

test("the reducer owns lifecycle ordering and omitted presentation fields for every writer", () => {
  const state = decodeChannelSnapshot(wire({ a: member([instance("a", "1", { status: "busy", model: "model", commands: [],
    statusChips: [{ id: "branch", label: "Branch", value: "main" }], lastSeenAt: "2026-10-16T09:00:00Z" })]) })).presence;
  const current = state.instances.get(presenceInstanceId("a"));
  const stale = reduceChannelPresence(state, { type: "upsert", source: "live", instance: { ...current,
    status: "offline", rest: "sleeping", model: undefined, commands: undefined, statusChips: undefined, lastSeenAt: at } });
  assert.equal(stale, state);
  const newer = reduceChannelPresence(state, { type: "upsert", source: "live", instance: { ...current,
    model: undefined, commands: undefined, statusChips: undefined, lastSeenAt: "2026-10-16T09:01:00Z" } });
  assert.equal(newer.instances.get(current.id).model, "model");
  assert.equal(newer.instances.get(current.id).statusChips[0].value, "main");
});

test("only a full Authority snapshot may restore a removed Instance or change its registration", () => {
  const state = decodeChannelSnapshot(wire({ a: member([instance("a", "1")]) })).presence;
  const current = state.instances.get(presenceInstanceId("a"));
  const removed = reduceChannelPresence(state, { type: "remove", instanceId: current.id });
  assert.throws(() => reduceChannelPresence(removed, { type: "upsert", source: "live", instance: current }), ChannelPresenceConflict);
  assert.throws(() => reduceChannelPresence(state, { type: "upsert", source: "live", instance: {
    ...current, registration: { ...current.registration, machineId: "different" },
  } }), ChannelPresenceConflict);
  assert.equal(removed.instances.size, 0);
  assert.equal(reduceChannelPresence(removed, { type: "snapshot", snapshot: state }).instances.size, 1);
});

test("a late message cannot wake an offline Instance even when its sender clock is later", () => {
  const state = decodeChannelSnapshot(wire({ a: member([instance("a", "1", { status: "offline", offlineReason: "machine_offline" })]) })).presence;
  const next = reduceChannelPresence(state, { type: "patch_known", source: "message", instanceId: presenceInstanceId("a"),
    patch: { status: "busy", rest: undefined, offlineReason: undefined, lastSeenAt: "2026-10-17T09:00:00Z" } });
  const current = next.instances.get(presenceInstanceId("a"));
  assert.equal(current.status, "offline");
  assert.equal(current.offlineReason, "machine_offline");
});

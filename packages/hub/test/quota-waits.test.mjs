import assert from "node:assert/strict";
import test from "node:test";
import { RegistrationAccessError } from "@xmatrix/db";
import { issueRegistrationQuotaProbes } from "../src/agent-routing-quota-refresh.ts";
import { deliverQuotaWakes, redeliverOwedQuotaWakes } from "../src/quota-waits.ts";

const target = (harness, extra = {}) => ({ ownerUserId: "owner", machineId: "machine", hostId: "host", harness,
  connectionEpoch: 4, quotaPoolId: `pool-${harness}`, configurationDigest: "c".repeat(64),
  targetId: `registration:${harness}`, ...extra });
const machines = { getDaemon: async () => ({ daemon: { id: "daemon", email: "owner@example.test", status: "online",
  capabilities: ["machine_quota_probe_v2"] } }) };

test("a refusal's check is one fresh probe per target, fenced by the reading that refused", async () => {
  const commands = [];
  const readAfter = "2026-11-02T08:00:00.000Z";
  const result = await issueRegistrationQuotaProbes({ env: {}, directory: {}, entries: [target("codex"), target("grok")],
    fresh: { readAfter } }, { machines, issue: async command => { commands.push(command); return {}; } });
  assert.deepEqual(result, { issued: 2 });
  for (const command of commands) {
    assert.equal(command.payload.probe.targets.length, 1, "a slow provider holds back no other target");
    assert.equal(command.payload.probe.fresh, true);
    assert.equal(command.payload.readAfter, readAfter, "the fence stays with the command, beside the probe");
    assert.equal(command.payload.probe.readAfter, undefined, "the daemon is never told the fence");
  }
  const plain = [];
  await issueRegistrationQuotaProbes({ env: {}, directory: {}, entries: [target("codex"), target("grok")] },
    { machines, issue: async command => { plain.push(command); return {}; } });
  assert.equal(plain.length, 1, "an ordinary refresh shares one probe per daemon");
  assert.equal(plain[0].payload.probe.fresh, undefined);
  assert.equal(plain[0].payload.readAfter, undefined);
});

function waitStore(waits, owed = []) {
  const settled = [];
  return { settled, store: {
    ready: async owner => waits.filter(wait => wait.ownerUserId === owner),
    settle: async done => { settled.push(...done); },
    owedOwners: async () => owed,
  } };
}

test("a ready wait wakes its Channel and is settled only once the Channel was told", async () => {
  const waits = [
    { ownerUserId: "owner", quotaPoolId: "pool-codex", channelId: "a", readyToken: "t1" },
    { ownerUserId: "owner", quotaPoolId: "pool-grok", channelId: "a", readyToken: "t2" },
    { ownerUserId: "owner", quotaPoolId: "pool-codex", channelId: "b", readyToken: "t3" },
    { ownerUserId: "owner", quotaPoolId: "pool-codex", channelId: "gone", readyToken: "t4" },
  ];
  const { settled, store } = waitStore(waits);
  const woken = [];
  const result = await deliverQuotaWakes({}, "owner", { waits: store,
    retries: async channelId => {
      if (channelId === "gone") throw new RegistrationAccessError("channel_not_found", 404);
      return { wake: async id => (id === "a" ? 2 : 0) };
    },
    wakeCoordinator: async channelId => {
      if (channelId === "b") throw new Error("unexpected wake");
      woken.push(channelId);
    } });
  assert.deepEqual(woken, ["a"], "only a Channel with a retry made due wakes its coordinator");
  assert.deepEqual(settled.map(wait => wait.readyToken).sort(), ["t1", "t2", "t3", "t4"],
    "a Channel told, with nothing to start, or gone is done");
  assert.equal(result.delivered, 4);

  const kept = waitStore(waits.slice(0, 1));
  await deliverQuotaWakes({}, "owner", { waits: kept.store,
    retries: async () => ({ wake: async () => 1 }),
    wakeCoordinator: async () => { throw new Error("coordinator unavailable"); } });
  assert.deepEqual(kept.settled, [], "a failed delivery keeps its wait for the next attempt");
});

test("redelivery reads the database only: it never asks a daemon or a provider", async () => {
  const { settled, store } = waitStore(
    [{ ownerUserId: "owner", quotaPoolId: "pool-codex", channelId: "a", readyToken: "t1" }], ["owner"]);
  const forbidden = () => { throw new Error("redelivery must not read quota"); };
  await redeliverOwedQuotaWakes({}, { waits: store, retries: async () => ({ wake: async () => 1 }),
    wakeCoordinator: async () => {}, issue: forbidden, machines: { getDaemon: forbidden } });
  assert.deepEqual(settled.map(wait => wait.readyToken), ["t1"]);
});

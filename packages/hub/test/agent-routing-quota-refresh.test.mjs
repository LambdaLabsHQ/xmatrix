import assert from "node:assert/strict";
import test from "node:test";
import {
  refreshAgentRoutingQuota,
} from "../src/agent-routing-quota-refresh.ts";
import { dispatchRegistrationLaunchesAfterMessage } from "../src/registration-launch-dispatch.ts";

function machines(capabilities = ["machine_quota_probe_v2"]) {
  return { getDaemon: async ({ ownerUserId }) => ({ daemon: { id: `daemon-${ownerUserId}`,
    email: `${ownerUserId}@example.test`, status: "online", capabilities } }) };
}

test("quota refresh issues probes and never waits for or writes a reading itself", async () => {
  const commands = [];
  const input = { env: {}, directory: {}, channelId: "channel", actorUserId: "caller",
    runtime: { launchChannelSpace: async () => ({ spaceId: "space" }) },
    registrationTargets: async spaceId => {
      assert.equal(spaceId, "space");
      return ["grok", "claude"].map(harness => ({ ownerUserId: "owner", machineId: "machine", hostId: "host",
        harness, connectionEpoch: 5, quotaPoolId: `pool-${harness}`, configurationDigest: "a".repeat(64),
        targetId: `registration:${harness}` }));
    } };
  const result = await refreshAgentRoutingQuota(input, { machines: machines(),
    issue: async (command) => { commands.push(command); return {}; } });
  assert.deepEqual(result, { issued: 1 });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].ownerUserId, "owner");
  assert.equal(commands[0].commandType, "quota_probe");
  assert.deepEqual(commands[0].payload.probe.targets, [
    { targetId: "registration:grok", configurationDigest: "a".repeat(64) },
    { targetId: "registration:claude", configurationDigest: "a".repeat(64) },
  ], "the probe names harnesses and digests only; pools stay server-bound");
});

test("a daemon without the probe capability is not asked", async () => {
  let issued = false;
  const result = await refreshAgentRoutingQuota({ env: {}, directory: {}, channelId: "channel", actorUserId: "caller",
    runtime: { launchChannelSpace: async () => ({ spaceId: "space" }) },
    registrationTargets: async () => [{ ownerUserId: "owner", machineId: "machine", hostId: "host", harness: "codex",
      connectionEpoch: 1, quotaPoolId: "pool", configurationDigest: "a".repeat(64), targetId: "registration:codex" }],
  }, { machines: machines([]), issue: async () => { issued = true; return {}; } });
  assert.deepEqual(result, { issued: 0 });
  assert.equal(issued, false);
});

test("multi-account refresh batches stay owner-scoped", async () => {
  const candidates = Array.from({ length: 90 }, (_, index) => ({
    targetId: `registration:${index}`, ownerUserId: index < 45 ? "owner-a" : "owner-b", harness: "codex",
    machineId: "same-machine-label", hostId: "same-host-label", quotaPoolId: `pool-${index}`,
    configurationDigest: index.toString(16).padStart(64, "0"), connectionEpoch: 3,
  }));
  const commands = new Map();
  let issuing = 0, peakIssuing = 0;
  const result = await refreshAgentRoutingQuota({ env: {}, directory: {}, channelId: "channel", actorUserId: "caller",
    runtime: { launchChannelSpace: async () => ({ spaceId: "space" }) },
    registrationTargets: async () => candidates,
  }, {
    machines: machines(),
    issue: async (input) => {
      assert.equal(input.principal.id, input.ownerUserId);
      assert.ok(input.payload.probe.targets.length <= 32);
      for (const target of input.payload.probe.targets) {
        assert.equal(candidates.find(item => item.targetId === target.targetId).ownerUserId, input.ownerUserId);
      }
      commands.set(input.controlId, input);
      peakIssuing = Math.max(peakIssuing, ++issuing);
      await new Promise(resolve => setImmediate(resolve));
      issuing--;
      return {};
    },
  });
  assert.deepEqual(result, { issued: 4 });
  assert.equal(commands.size, 4);
  assert.ok(peakIssuing > 1 && peakIssuing <= 4);
  assert.equal([...commands.values()].reduce((sum, command) => sum + command.payload.probe.targets.length, 0), 90);
});

test("a composite registration dispatch schedules a quota refresh; a legacy one does not", async () => {
  for (const [mode, selectionCount, expected] of [["composite", 1, true], ["legacy", 0, false], ["composite", 0, false]]) {
    const refreshed = [], tasks = [];
    await dispatchRegistrationLaunchesAfterMessage({ env: {}, channelId: "channel", messageId: "message",
      body: "@grok hi", actorUserId: "caller", scheduleBackground: task => tasks.push(task) }, {
      refreshQuota: async ({ channelId, actorUserId }) => {
        refreshed.push({ channelId, actorUserId });
        return { issued: 0 };
      },
      launch: async () => ({ mode, selectionCount, prepared: [] }),
    });
    await Promise.all(tasks);
    assert.equal(refreshed.length > 0, expected, `${mode}/${selectionCount}`);
    if (expected) assert.deepEqual(refreshed, [{ channelId: "channel", actorUserId: "caller" }]);
  }
});

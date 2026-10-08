const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();

const { patchChannelsRegistrationQuota } = require("./registration-quota-patch.ts");

const key = { ownerUserId: "owner", machineId: "machine", harness: "claude" };
const observedAt = "2026-10-08T12:00:00.000Z";
const reading = (percent) => ({
  quotaState: "observed", quotaObservedAt: observedAt, quotaSource: "provider_api", quotaUsages: [{ label: "5h", percent }],
});

function channel(id, registration = key) {
  return {
    id,
    memberPresence: {
      agent: { kind: "agent", registration, usage: reading(10),
        instances: [{ id: `${id}-1`, status: "busy", usage: { totalTokens: 7, ...reading(10) } }] },
      person: { kind: "user", status: "online" },
    },
  };
}

test("every Agent under the registration takes the reading and keeps its own counters", () => {
  const channels = [channel("a"), channel("b", { ...key, machineId: "other-machine" })];
  const patched = patchChannelsRegistrationQuota(channels, key, reading(40));
  const agent = patched[0].memberPresence.agent;
  assert.equal(agent.usage.quotaUsages[0].percent, 40);
  assert.equal(agent.instances[0].usage.quotaUsages[0].percent, 40);
  assert.equal(agent.instances[0].usage.totalTokens, 7);
  assert.equal(patched[0].memberPresence.person, channels[0].memberPresence.person);
  assert.equal(patched[1], channels[1], "another registration's Agents are untouched");
});

test("an expired reading withdraws the windows and keeps the counters", () => {
  const [patched] = patchChannelsRegistrationQuota([channel("a")], key, { quotaState: "unknown", quotaObservedAt: observedAt });
  const agent = patched.memberPresence.agent;
  assert.equal(agent.usage.quotaState, "unknown");
  assert.equal(agent.usage.quotaUsages, undefined);
  assert.equal(agent.instances[0].usage.quotaUsages, undefined);
  assert.equal(agent.instances[0].usage.totalTokens, 7);
});

test("a reading the Channels already show changes nothing", () => {
  const channels = patchChannelsRegistrationQuota([channel("a")], key, reading(40));
  assert.equal(patchChannelsRegistrationQuota(channels, key, reading(40)), channels);
});

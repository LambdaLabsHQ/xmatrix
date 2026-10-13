const assert = require("node:assert/strict");
const test = require("node:test");
const { loadWorkspaceShellModuleMap, loadShellFunctions } = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname);

const PRESENCE_FUNCTIONS = [
  "timestampMs",
  "earliestTimestamp",
  "latestTimestamp",
  "mergeLlmUsagePreferringQuotas",
  "mergeAccountLevelLlmUsage",
  "accountQuotaUsageFromCandidates",
  "usageWithoutQuota",
  "mergeUsageAttributes",
  "reportedPresenceEntries",
  "sameReportedPresenceValue",
  "instanceLifecycleReportApplies",
  "mergeAgentInstancePresence",
  "replaceChannelMemberPresence",
  "patchChannelAgentPresenceFromAgent",
  "patchChannelInstancesById",
  "patchChannelAgentMemberFromAgent",
  "patchChannelsAgentPresenceBatch",
];


const { patchChannelsAgentPresenceBatch } = loadShellFunctions(shellModules, PRESENCE_FUNCTIONS);
const patchChannelsAgentPresenceFromAgent = (channels, agent) => patchChannelsAgentPresenceBatch(channels, [agent]);
const { patchChannelAgentPresenceFromAgent } = loadShellFunctions(shellModules, PRESENCE_FUNCTIONS);

/** Claude's one working instance, as both the heartbeat and the Channel report it. */
function workingInstance() {
  return {
    id: "instance-1",
    channelId: "channel-1",
    channelInstanceId: 1,
    status: "busy",
    runtimeState: "working",
    lastSeenAt: "2026-09-19T12:00:00.000Z",
    connectedAt: "2026-09-19T11:00:00.000Z",
    statusChips: [{ label: "chore/release", kind: "branch" }],
    model: "claude-fable-5-1",
  };
}

function heartbeatAgent() {
  return {
    id: "agent:claude",
    name: "Claude",
    lastSeenAt: "2026-09-19T12:00:00.000Z",
    instances: [workingInstance()],
  };
}

function channelsWithAgentPresence() {
  return [
    {
      id: "channel-1",
      name: "general",
      memberPresence: {
        "agent:claude": {
          kind: "agent",
          label: "Claude",
          lastSeenAt: "2026-09-19T12:00:00.000Z",
          instances: [workingInstance()],
        },
      },
    },
  ];
}

test("a heartbeat that reports nothing new leaves the Channel list identity untouched", () => {
  const channels = channelsWithAgentPresence();

  // The five-second heartbeat repeats the same presence. Re-rendering the whole
  // Channel tree every five seconds is what makes the sidebar and timeline move
  // under the reader, so an unchanged report must reuse the existing objects.
  const first = patchChannelsAgentPresenceFromAgent(channels, heartbeatAgent());
  const second = patchChannelsAgentPresenceFromAgent(first, heartbeatAgent());
  const third = patchChannelsAgentPresenceFromAgent(second, heartbeatAgent());

  assert.equal(second, first, "a repeated heartbeat must not rebuild the Channel array");
  assert.equal(third, second, "repeated heartbeats must stay idempotent");
  assert.equal(second[0], first[0], "a repeated heartbeat must not rebuild the Channel object");
  assert.equal(
    second[0].memberPresence["agent:claude"].instances[0],
    first[0].memberPresence["agent:claude"].instances[0],
    "a repeated heartbeat must not rebuild the instance object",
  );
});

test("a heartbeat carrying a real change still rebuilds the Channel", () => {
  const channels = channelsWithAgentPresence();
  const settled = patchChannelsAgentPresenceFromAgent(channels, heartbeatAgent());

  const nextAgent = heartbeatAgent();
  nextAgent.instances[0].status = "idle";
  nextAgent.instances[0].runtimeState = "waiting";
  nextAgent.instances[0].lastSeenAt = "2026-09-19T12:00:05.000Z";
  const changed = patchChannelsAgentPresenceFromAgent(settled, nextAgent);

  assert.notEqual(changed, settled, "a real status change must produce a new Channel array");
  assert.equal(changed[0].memberPresence["agent:claude"].instances[0].status, "idle");
  assert.equal(
    changed[0].memberPresence["agent:claude"].instances[0].statusChips[0].label,
    "chore/release",
    "the tags must survive the change that did not report them",
  );
});

test("an Instance shown machine-offline returns to its reported status when the machine reconnects", () => {
  const settled = patchChannelsAgentPresenceFromAgent(channelsWithAgentPresence(), heartbeatAgent());

  const unreachable = heartbeatAgent();
  unreachable.instances[0].status = "offline";
  unreachable.instances[0].offlineReason = "machine_offline";
  const offline = patchChannelsAgentPresenceFromAgent(settled, unreachable);
  const offlineInstance = offline[0].memberPresence["agent:claude"].instances[0];
  assert.equal(offlineInstance.status, "offline");
  assert.equal(offlineInstance.offlineReason, "machine_offline");

  // The reconnect frame states no reason; a patch merge must not keep the old one.
  const reconnected = heartbeatAgent();
  reconnected.instances[0].status = "idle";
  const back = patchChannelsAgentPresenceFromAgent(offline, reconnected);
  const backInstance = back[0].memberPresence["agent:claude"].instances[0];
  assert.equal(backInstance.status, "idle");
  assert.equal(backInstance.offlineReason, undefined);
});

test("one Run's presentation cannot change sibling Channels of the same Agent", () => {
  const channel = channelsWithAgentPresence()[0];
  const other = heartbeatAgent();
  other.activity = "Working elsewhere";
  other.intent = { summary: "Another task" };
  other.lastSeenAt = "2026-09-19T12:01:00.000Z";
  other.instances = [{ ...workingInstance(), id: "elsewhere", channelId: "another-channel" }];
  assert.equal(patchChannelAgentPresenceFromAgent(channel, other), channel);
  // Account limits still reach every Channel, without carrying the Run's intent.
  other.usage = { quotaSource: "provider_api", quotaObservedAt: "2026-09-19T12:01:00.000Z",
    quotaUsages: [{ percent: 95, label: "5h" }], totalTokens: 1 };
  const updated = patchChannelAgentPresenceFromAgent(channel, other);
  const presence = updated.memberPresence[other.id];
  assert.equal(presence.activity, channel.memberPresence[other.id].activity);
  assert.equal(presence.intent, undefined);
  assert.equal(presence.lastSeenAt, channel.memberPresence[other.id].lastSeenAt);
  assert.equal(presence.usage.quotaUsages[0].percent, 95);
  assert.equal(presence.usage.totalTokens, undefined, "another Run's token counters are not account quota");
  assert.equal(patchChannelAgentPresenceFromAgent(updated, other), updated, "the same quota is a no-op");
});

for (const sameAgent of [false, true]) test(`a thousand reports route once (${sameAgent ? "one Agent" : "independent Agents"})`, () => {
  let reads = 0;
  const channels = Array.from({ length: 1000 }, (_, index) => ({
    id: `channel-${index}`,
    get memberPresence() {
      reads += 1;
      return { [`agent:${sameAgent ? 0 : index}`]: { kind: "agent", instances: [{
        ...workingInstance(), id: `instance-${index}`, channelId: `channel-${index}`,
      }] } };
    },
  }));
  const reports = channels.map((channel, index) => ({
    ...heartbeatAgent(), id: `agent:${sameAgent ? 0 : index}`,
    usage: { quotaSource: "provider_api", quotaObservedAt: "2026-09-19T12:01:00.000Z",
      quotaUsages: [{ label: "5h", percent: 95 }] }, instances: [{
      ...workingInstance(), id: `instance-${index}`, channelId: channel.id, activity: "New activity",
    }],
  }));
  const updated = patchChannelsAgentPresenceBatch(channels, reports);
  assert.ok(reads < 20_000, `unrelated Channels were inspected ${reads} times`);
  updated.forEach((channel, index) => assert.equal(
    channel.memberPresence[`agent:${sameAgent ? 0 : index}`].instances[0].activity, "New activity"));
});

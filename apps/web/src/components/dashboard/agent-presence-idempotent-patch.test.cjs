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
  "patchChannelsAgentPresenceFromAgent",
];


const { patchChannelsAgentPresenceFromAgent } = loadShellFunctions(shellModules, PRESENCE_FUNCTIONS);

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

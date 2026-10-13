const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { loadWorkspaceShellModuleMap, loadShellFunctions } = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname);
for (const file of ["channel-viewer-state.ts", "channel-links.ts"]) {
  shellModules.set(file, fs.readFileSync(path.join(__dirname, file), "utf8"));
}

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
  "createChannelPresenceBatch",
  "mergeChannelListHydratedFields",
  "mergeChannelViewerState",
  "mergeChannelMemberReadSequences",
  "mergeChannelMemberPresencePreferringQuotas",
  "sameChannelCatalogState",
  "compareChannelsForSidebar",
  "channelIsPinned",
  "channelPinnedAtMs",
  "compareChannelsByRecentActivity",
  "channelRecentActivityMs",
  "channelTitle",
  "sortChannels",
];


const { createChannelPresenceBatch, sameChannelCatalogState } =
  loadShellFunctions(shellModules, PRESENCE_FUNCTIONS);
const patchChannelsAgentPresenceBatch = (channels, agents) => {
  const batch = createChannelPresenceBatch(channels);
  batch.applyPresence(agents);
  return batch.getSnapshot();
};
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


test("alternating cards and snapshots reuse routing without revisiting unrelated Channels", () => {
  let reads = 0;
  const channels = Array.from({ length: 1000 }, (_, index) => ({
    id: `channel-${index}`,
    name: `conversation-${index}`,
    get memberPresence() {
      reads += 1;
      return { [`agent:${index}`]: { kind: "agent", instances: [{
        ...workingInstance(), id: `instance-${index}`, channelId: `channel-${index}`,
      }] } };
    },
  }));
  const batch = createChannelPresenceBatch(channels);
  for (let index = 0; index < 100; index += 1) {
    const instance = { ...workingInstance(), id: `instance-${index}`, channelId: `channel-${index}`,
      activity: `Step ${index}` };
    batch.applyPresence([{ ...heartbeatAgent(), id: `agent:${index}`, instances: [instance] }]);
    batch.applyChannel({ id: `channel-${index}`, name: `conversation-${index}`, memberPresence: {
      [`agent:${index}`]: { kind: "agent", instances: [instance] },
    } });
  }
  const updated = batch.getSnapshot();
  assert.ok(reads < 5_000, `the alternating stream inspected unrelated presence ${reads} times`);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(updated[index].memberPresence[`agent:${index}`].instances[0].activity, `Step ${index}`);
  }
  assert.equal(updated[999], channels[999], "unreported Channels retain identity");
});

test("partial snapshots retain cursors, tags and quotas across an ordered state run", () => {
  const channel = channelsWithAgentPresence()[0];
  channel.readSequence = 15;
  channel.messageCount = 40;
  channel.memberReadSequences = { viewer: 15 };
  channel.memberPresence["agent:claude"].usage = {
    quotaSource: "provider_api", quotaObservedAt: "2026-09-19T12:00:00.000Z",
    quotaUsages: [{ label: "5h", percent: 80 }],
  };
  const batch = createChannelPresenceBatch([channel]);
  batch.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "First" }] }]);
  batch.applyChannel({ id: channel.id, name: channel.name, memberReadSequences: { viewer: 4 },
    memberPresence: { "agent:claude": { kind: "agent", instances: [{
      id: "instance-1", channelId: channel.id, status: "busy", activity: "Second",
      lastSeenAt: "2026-09-19T12:00:01.000Z",
    }] } } });
  batch.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(),
    activity: "Final", lastSeenAt: "2026-09-19T12:00:02.000Z" }] }]);
  const updated = batch.getSnapshot()[0];
  const presence = updated.memberPresence["agent:claude"];
  assert.equal(updated.readSequence, 15);
  assert.equal(updated.messageCount, 40);
  assert.equal(updated.memberReadSequences.viewer, 15, "a partial push cannot roll back a read cursor");
  assert.equal(presence.usage.quotaUsages[0].percent, 80);
  assert.equal(presence.instances[0].activity, "Final");
  assert.equal(presence.instances[0].model, "claude-fable-5-1");
  assert.equal(presence.instances[0].statusChips[0].label, "chore/release");
  assert.equal(channel.memberPresence["agent:claude"].instances[0].activity, undefined, "staging is immutable");
});

test("a snapshot changing an Instance or member updates the next card's routing and catalog decision", () => {
  const channel = channelsWithAgentPresence()[0];
  const batch = createChannelPresenceBatch([channel]);
  // Build the routes, then replace both the legacy member key and Instance id.
  batch.applyPresence([heartbeatAgent()]);
  const { previous, updated } = batch.applyChannel({ ...channel,
    memberPresence: { "member:new": { kind: "agent", instances: [{
      ...workingInstance(), id: "instance-new", channelInstanceId: "2",
    }] } },
  });
  assert.equal(sameChannelCatalogState(previous, updated), false, "roster changes still require catalog publication");
  batch.applyPresence([{ ...heartbeatAgent(), id: "principal:new", instances: [{
    ...workingInstance(), id: "instance-new", activity: "New Run", lastSeenAt: "2026-09-19T12:00:01.000Z",
  }] }]);
  batch.applyPresence([{ ...heartbeatAgent(), instances: [{
    ...workingInstance(), activity: "Old Run", lastSeenAt: "2026-09-19T12:00:02.000Z",
  }] }]);
  const result = batch.getSnapshot()[0];
  assert.equal(result.memberPresence["member:new"].instances[0].activity, "New Run");
  assert.equal(result.memberPresence["agent:claude"], undefined);
  assert.equal(sameChannelCatalogState(channel, result), false, "the prior catalog baseline also detects a replaced Run");
});

test("snapshots keep sidebar ordering and cannot cross an explicitly published state boundary", () => {
  const older = { ...channelsWithAgentPresence()[0], updatedAt: "2026-09-19T10:00:00.000Z" };
  const batch = createChannelPresenceBatch([older]);
  batch.applyChannel({ id: "channel-2", name: "later", updatedAt: "2026-09-19T11:00:00.000Z" });
  batch.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "Before message" }] }]);
  const beforeMessage = batch.getSnapshot();
  assert.deepEqual(beforeMessage.map(channel => channel.id), ["channel-2", "channel-1"]);
  const after = createChannelPresenceBatch(beforeMessage);
  after.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "After message" }] }]);
  assert.equal(beforeMessage[1].memberPresence["agent:claude"].instances[0].activity, "Before message");
  assert.equal(after.getSnapshot()[1].memberPresence["agent:claude"].instances[0].activity, "After message");
});


test("a rejected snapshot cannot leak through the later flush or damage the next Instance route", () => {
  const channel = channelsWithAgentPresence()[0];
  const batch = createChannelPresenceBatch([channel]);
  batch.applyPresence([heartbeatAgent()]);
  const before = batch.getSnapshot()[0];
  assert.throws(() => batch.applyChannel({ ...channel, mode: "closed", name: "rejected" }, () => {
    throw new Error("classification failed");
  }), /classification failed/);
  assert.equal(batch.getSnapshot()[0], before, "a failed classification never stages its snapshot");
  // This can arrive as malformed JSON, and used to remove the old routes
  // before discovering the malformed replacement's Instance collection.
  assert.throws(() => batch.applyChannel({ ...channel, memberPresence: {
    "replacement-member": { kind: "agent", instances: {} },
  } }));
  assert.equal(batch.getSnapshot()[0], before);
  assert.throws(() => batch.applyChannel({ id: "invalid-new", name: 7 }));
  assert.deepEqual(batch.getSnapshot().map(item => item.id), [channel.id]);
  const report = { ...workingInstance(), activity: "Good after rejected snapshots" };
  delete report.channelId;
  batch.applyPresence([{ ...heartbeatAgent(), id: "another-principal", instances: [report] }]);
  assert.equal(batch.getSnapshot()[0].memberPresence["agent:claude"].instances[0].activity,
    "Good after rejected snapshots", "a rejected snapshot cannot poison global Instance routing");
});

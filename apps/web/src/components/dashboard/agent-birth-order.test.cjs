const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { loadWorkspaceShellModuleMap, loadShellFunctions } = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname);
for (const file of ["use-channel-catalog-paging.ts", "channel-viewer-state.ts"]) {
  shellModules.set(file, fs.readFileSync(path.join(__dirname, file), "utf8"));
}

// Pure helpers only — no React or workspace shell runtime.
const ORDERING_FUNCTIONS = [
  "mergeChannels",
  "mergeChannelViewerState",
  "mergeChannelMemberReadSequences",
  "mergeChannelListHydratedFields",
  "timestampMs",
  "earliestTimestamp",
  "latestTimestamp",
  "compareChannelAgentAvatarBirthOrder",
  "reportedPresenceEntries",
  "sameReportedPresenceValue",
  "instanceLifecycleReportApplies",
  "mergeAgentInstancePresence",
  "mergeAccountLevelLlmUsage",
  "accountQuotaUsageFromCandidates",
  "usageWithoutQuota",
  "mergeUsageAttributes",
  "agentMemberUsage",
  "busiestAgentInstance",
  "preferredQuotaUsage",
  "hasQuotaMeterUsage",
  "providerQuotaUsages",
  "patchChannelAgentPresenceFromAgent",
  "patchChannelInstancesById",
  "patchChannelAgentMemberFromAgent",
  "mergeLlmUsagePreferringQuotas",
  "mergeChannelMemberPresencePreferringQuotas",
  "replaceChannelMemberPresence",
  "removeChannelAgentInstancePresence",
  "channelsAfterAgentInstanceOffline",
  "historicalSenderAvatarUrl",
  "patchChannelAgentPresenceFromMessage",
  "agentMessageInstanceIdentityIncomplete",
];


const functions = loadShellFunctions(shellModules, ORDERING_FUNCTIONS, "exports.mergeChannels = mergeChannels;");
const {
  mergeChannels,
  compareChannelAgentAvatarBirthOrder,
  mergeAgentInstancePresence,
  patchChannelAgentPresenceFromAgent,
  mergeChannelMemberPresencePreferringQuotas,
  removeChannelAgentInstancePresence,
  channelsAfterAgentInstanceOffline,
  historicalSenderAvatarUrl,
  patchChannelAgentPresenceFromMessage,
  agentMessageInstanceIdentityIncomplete,
} = functions;

test("paged catalog refresh retains live labels and busy state, then accepts idle and removal", () => {
  const initial = { id: "instance-1", channelInstanceId: "1", status: "idle",
    connectedAt: "2026-09-19T10:00:00Z", lastSeenAt: "2026-09-19T10:00:00Z" };
  const live = mergeAgentInstancePresence(initial, { ...initial, status: "busy",
    activity: "Working", lastSeenAt: "2026-09-19T10:00:10Z", model: "gpt-live", effort: "high",
    statusChips: [{ id: "sandbox", label: "Sandbox", value: "workspace-write" }],
    gitBranch: "fix/presence", runtimeState: { status: "running" },
  });
  const channel = (instance) => ({ id: "channel-1", memberPresence: {
    "agent-1": { kind: "agent", instances: [instance] },
  } });
  const instance = (channels) => channels[0].memberPresence["agent-1"].instances[0];
  let channels = mergeChannels([channel(live)], [channel(initial)]);
  assert.deepEqual(instance(channels), live, "a delayed page must not replace the live card");
  channels = mergeChannels(channels, [channel({ ...initial, status: "busy",
    lastSeenAt: "2026-09-19T10:00:15Z" })]);
  assert.equal(instance(channels).model, "gpt-live");
  assert.equal(instance(channels).effort, "high");
  assert.deepEqual(instance(channels).statusChips, live.statusChips);
  channels = mergeChannels(channels, [channel({ ...initial, lastSeenAt: "2026-09-19T10:00:20Z" })]);
  assert.equal(instance(channels).status, "idle");
  assert.equal(instance(channels).activity, undefined, "idle cannot retain the old Working label");
  assert.equal(instance(channels).runtimeState, undefined);
  channels = mergeChannels(channels, [{ id: "channel-1", memberPresence: {} }]);
  assert.deepEqual(channels[0].memberPresence, {}, "authoritative removal must still clear the card");
});

{
  const merge = mergeAgentInstancePresence;
  test("instance presence merge rejects stale idle and isolates reborn presentation", () => {
    const current = { id: "old", channelInstanceId: "1", status: "busy", model: "gpt-live",
      connectedAt: "2026-09-19T10:00:00Z", lastSeenAt: "2026-09-19T10:00:10Z" };
    assert.equal(merge(current, { ...current, status: "idle", model: "gpt-old",
      lastSeenAt: "2026-09-19T10:00:05Z" }), current);
    assert.equal(merge(current, { ...current, status: "offline",
      lastSeenAt: "2026-09-19T10:00:05Z" }).status, "offline");
    const reborn = merge(current, { id: "new", channelInstanceId: "1", status: "online",
      connectedAt: "2026-09-19T10:00:20Z", lastSeenAt: "2026-09-19T10:00:20Z" });
    assert.equal(reborn.model, undefined);
    assert.equal(reborn.status, "online");
    assert.equal(reborn.connectedAt, current.connectedAt);
  });
}

test("an Agent message without an ordinal never creates an unaddressable live card", () => {
  const entry = {
    messageId: "message-1",
    channelId: "channel-1",
    sentAt: "2026-09-05T00:00:00.000Z",
    from: {
      kind: "agent",
      identityId: "agent:codex",
      instanceId: "instance-new",
      label: "Codex",
    },
  };
  const next = patchChannelAgentPresenceFromMessage({
    id: "channel-1",
    memberPresence: {},
  }, entry);
  assert.equal(agentMessageInstanceIdentityIncomplete(entry), true);
  assert.deepEqual(next.memberPresence["agent:codex"].instances, undefined);
});

test("an incomplete Agent message may update only its already-known exact Instance", () => {
  const entry = {
    messageId: "message-2",
    channelId: "channel-1",
    sentAt: "2026-09-05T00:01:00.000Z",
    from: {
      kind: "agent",
      identityId: "agent:codex",
      instanceId: "instance-known",
      label: "Codex",
      goal: { status: "working", summary: "Test" },
    },
  };
  const next = patchChannelAgentPresenceFromMessage({
    id: "channel-1",
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        label: "Codex",
        instances: [{
          id: "instance-known",
          channelInstanceId: "7",
          label: "Codex:7",
          connectedAt: "2026-09-05T00:00:00.000Z",
          lastSeenAt: "2026-09-05T00:00:00.000Z",
          status: "online",
        }],
      },
    },
  }, entry);
  assert.equal(next.memberPresence["agent:codex"].instances.length, 1);
  assert.equal(next.memberPresence["agent:codex"].instances[0].channelInstanceId, "7");
  assert.equal(next.memberPresence["agent:codex"].instances[0].status, "busy");
});

test("an immutable message avatar wins over live presence", () => {
  assert.equal(
    historicalSenderAvatarUrl({
      snapshotAvatarUrl: "/avatars/reviewer-v1.png",
      presenceAvatarUrl: "/agent-vendors/openai.svg",
    }),
    "/avatars/reviewer-v1.png",
  );
});

function avatarItem(partial) {
  return {
    key: partial.key,
    member: partial.member,
    instance: partial.instance,
    connectedAt: partial.connectedAt ?? partial.instance?.connectedAt,
    instanceIndex: partial.instanceIndex ?? 0,
  };
}

test("Agents detail rows sort by birth connectedAt, not lastSeen activity", () => {
  const older = avatarItem({
    key: "agent:a:old",
    member: "agent:a",
    instance: {
      id: "old",
      channelInstanceId: "1",
      connectedAt: "2026-08-01T10:00:00.000Z",
      lastSeenAt: "2026-08-01T12:00:00.000Z",
      status: "idle",
    },
  });
  const newer = avatarItem({
    key: "agent:b:new",
    member: "agent:b",
    instance: {
      id: "new",
      channelInstanceId: "1",
      connectedAt: "2026-08-01T11:00:00.000Z",
      lastSeenAt: "2026-08-01T13:00:00.000Z",
      status: "busy",
    },
  });

  assert.deepEqual(
    [newer, older].sort(compareChannelAgentAvatarBirthOrder).map((item) => item.key),
    ["agent:a:old", "agent:b:new"]
  );
});

test("live presence merge never advances connectedAt birth clock", () => {
  const birth = "2026-08-01T10:00:00.000Z";
  const merged = mergeAgentInstancePresence(
    {
      id: "instance-1",
      channelInstanceId: "1",
      connectedAt: birth,
      lastSeenAt: birth,
      status: "idle",
    },
    {
      id: "instance-1",
      channelInstanceId: "1",
      connectedAt: "2026-08-01T12:00:00.000Z",
      lastSeenAt: "2026-08-01T12:00:00.000Z",
      status: "busy",
      activity: "Thinking",
    }
  );
  assert.equal(merged.connectedAt, birth);
  assert.equal(merged.status, "busy");
  assert.equal(merged.activity, "Thinking");
});

test("heartbeat presence patch preserves runtime presentation tags", () => {
  const presentation = {
    model: "gpt-5",
    models: [{ id: "gpt-5", label: "GPT-5" }],
    effort: "high",
    commands: [{ token: "/model", label: "Model" }],
    statusChips: [
      { id: "model", label: "Model", value: "gpt-5" },
      { id: "effort", label: "Effort", value: "high" },
    ],
    gitBranch: "fix/preserve-tags",
  };
  const merged = mergeAgentInstancePresence(
    {
      id: "instance-1",
      channelInstanceId: "1",
      connectedAt: "2026-09-19T10:00:00.000Z",
      lastSeenAt: "2026-09-19T10:00:00.000Z",
      status: "busy",
      ...presentation,
    },
    {
      id: "instance-1",
      channelInstanceId: "1",
      connectedAt: "2026-09-19T10:00:00.000Z",
      lastSeenAt: "2026-09-19T10:00:05.000Z",
      status: "busy",
      runtimeState: { status: "running" },
    }
  );

  for (const [field, value] of Object.entries(presentation)) {
    assert.deepEqual(merged[field], value, `${field} survives a heartbeat patch`);
  }
});

test("catalog merge keeps earlier birth when reborn carries a newer socket clock", () => {
  const birth = "2026-08-01T09:00:00.000Z";
  const merged = mergeAgentInstancePresence(
    {
      id: "instance-old",
      channelInstanceId: "2",
      connectedAt: birth,
      lastSeenAt: birth,
      status: "offline",
    },
    {
      id: "instance-new",
      channelInstanceId: "2",
      connectedAt: "2026-08-01T14:00:00.000Z",
      lastSeenAt: "2026-08-01T14:00:00.000Z",
      status: "online",
    }
  );
  assert.equal(merged.connectedAt, birth);
  assert.equal(merged.id, "instance-new");
  assert.equal(merged.status, "online");
});

test("catalog presence snapshot cannot erase live runtime presentation tags", () => {
  const statusChips = [{ id: "model", label: "Model", value: "claude-opus-4-1" }];
  const merged = mergeAgentInstancePresence(
    {
      id: "instance-1",
      channelInstanceId: "1",
      connectedAt: "2026-09-19T10:00:00.000Z",
      lastSeenAt: "2026-09-19T10:00:10.000Z",
      status: "busy",
      model: "claude-opus-4-1",
      effort: "high",
      statusChips,
      gitBranch: "fix/preserve-tags",
    },
    {
      id: "instance-1",
      channelInstanceId: "1",
      connectedAt: "2026-09-19T10:00:00.000Z",
      lastSeenAt: "2026-09-19T10:00:00.000Z",
      status: "online",
    }
  );

  assert.equal(merged.model, "claude-opus-4-1");
  assert.equal(merged.effort, "high");
  assert.deepEqual(merged.statusChips, statusChips);
  assert.equal(merged.gitBranch, "fix/preserve-tags");
});

function livePresence(instanceId) {
  return {
    kind: "agent",
    label: "Codex",
    instances: [{
      id: instanceId,
      channelInstanceId: "1",
      connectedAt: "2026-08-01T10:00:00.000Z",
      lastSeenAt: "2026-08-01T10:00:00.000Z",
      status: "online",
    }],
  };
}

/** Channel 1 with two live Codex Instances: `instance-1` and a busy `instance-2`. */
function channelWithTwoCodexInstances() {
  return {
    id: "channel-1",
    memberPresence: {
      "agent:codex": {
        kind: "agent",
        label: "Codex",
        instances: [
          livePresence("instance-1").instances[0],
          {
            id: "instance-2",
            channelInstanceId: "2",
            connectedAt: "2026-08-01T10:01:00.000Z",
            lastSeenAt: "2026-08-01T10:01:00.000Z",
            status: "busy",
          },
        ],
      },
    },
  };
}

test("empty memberPresence from a computed snapshot clears leftover Agent chips", () => {
  const prior = { "agent:codex": livePresence("instance-1") };
  assert.deepEqual(mergeChannelMemberPresencePreferringQuotas(prior, {}), {});
});

test("omitted memberPresence keeps the prior live snapshot", () => {
  const prior = { "agent:codex": livePresence("instance-1") };
  assert.equal(mergeChannelMemberPresencePreferringQuotas(prior, undefined), prior);
});

test("removing one stopped Instance leaves the remaining live chips", () => {
  const channel = channelWithTwoCodexInstances();
  const next = removeChannelAgentInstancePresence(channel, {
    agentId: "agent:codex",
    instanceId: "instance-1",
  });
  assert.deepEqual(
    next.memberPresence["agent:codex"].instances.map((instance) => instance.id),
    ["instance-2"],
  );
});

test("removing the last Instance drops the Agent presence row", () => {
  const channel = {
    id: "channel-1",
    memberPresence: { "agent:codex": livePresence("instance-1") },
  };
  const next = removeChannelAgentInstancePresence(channel, {
    agentId: "agent:codex",
    instanceId: "instance-1",
  });
  assert.deepEqual(next.memberPresence, {});
});

test("offline lifecycle updates decrement the channel chip list one Instance at a time", () => {
  const channels = [channelWithTwoCodexInstances()];
  const afterFirst = channelsAfterAgentInstanceOffline(channels, {
    channelId: "channel-1",
    agentId: "agent:codex",
    instanceId: "instance-1",
  });
  assert.deepEqual(
    afterFirst[0].memberPresence["agent:codex"].instances.map((instance) => instance.id),
    ["instance-2"],
  );
  const afterSecond = channelsAfterAgentInstanceOffline(afterFirst, {
    channelId: "channel-1",
    agentId: "agent:codex",
    instanceId: "instance-2",
  });
  assert.deepEqual(afterSecond[0].memberPresence, {});
});

test("a woken Instance never takes back the moon from a catalog snapshot read before the wake", () => {
  const asleep = { id: "ch:1", channelInstanceId: "1", status: "offline", rest: "sleeping",
    connectedAt: "2026-10-02T07:00:00Z", lastSeenAt: "2026-10-02T07:50:00Z" };
  const channel = (instance) => ({ id: "ch", memberPresence: {
    "ch:1": { kind: "agent", label: "claude", instances: [instance] },
  } });
  const instance = (channels) => channels[0].memberPresence["ch:1"].instances[0];
  // The woken Instance replies: the message proves it is live.
  let channels = [patchChannelAgentPresenceFromMessage(channel(asleep), {
    channelId: "ch", sentAt: "2026-10-02T08:26:10Z",
    from: { kind: "agent", identityId: "ch:1", instanceId: "ch:1", channelInstanceId: "1" },
  })];
  assert.equal(instance(channels).status, "busy");
  assert.equal(instance(channels).rest, undefined, "the sleep's rest goes with the sleep's status");
  // The query cache replays the page it read before the wake.
  channels = mergeChannels(channels, [channel(asleep)]);
  assert.equal(instance(channels).status, "busy", "a snapshot from before the wake cannot put it back to sleep");
  // The refetched page reads the connect row, older than the reply but newer than the sleep.
  channels = mergeChannels(channels, [channel({ ...asleep, status: "online", rest: undefined,
    lastSeenAt: "2026-10-02T08:26:00Z" })]);
  assert.equal(instance(channels).status, "busy");
  // The turn ends: idle from the live socket, which names its principal, not the catalog key.
  channels = channels.map((current) => patchChannelAgentPresenceFromAgent(current, {
    id: "principal-agent", name: "claude", lastSeenAt: "2026-10-02T08:27:30Z",
    instances: [{ id: "ch:1", channelId: "ch", channelInstanceId: "1", status: "idle",
      connectedAt: "2026-10-02T08:26:00Z", lastSeenAt: "2026-10-02T08:27:30Z" }],
  }));
  assert.equal(instance(channels).status, "idle", "a live report reaches the Instance under any member key");
  // It sleeps again: the newer resting snapshot applies whole.
  channels = mergeChannels(channels, [channel({ ...asleep, lastSeenAt: "2026-10-02T09:00:00Z" })]);
  assert.equal(instance(channels).status, "offline");
  assert.equal(instance(channels).rest, "sleeping");
});

test("lifecycle is one report: status, rest and offlineReason never mix across reports", () => {
  const live = { id: "i", channelInstanceId: "1", status: "busy",
    connectedAt: "2026-10-02T08:00:00Z", lastSeenAt: "2026-10-02T08:10:00Z" };
  const resting = { ...live, status: "offline", rest: "sleeping", lastSeenAt: "2026-10-02T08:05:00Z" };
  assert.equal(mergeAgentInstancePresence(live, resting), live, "an older resting report is stale");
  const asleep = mergeAgentInstancePresence(live, { ...resting, lastSeenAt: "2026-10-02T08:20:00Z" });
  assert.equal(asleep.rest, "sleeping");
  assert.equal(asleep.lastSeenAt, "2026-10-02T08:20:00Z");
  const machineOffline = mergeAgentInstancePresence(live, { ...live, status: "offline",
    offlineReason: "machine_offline", lastSeenAt: "2026-10-02T08:01:00Z" });
  assert.equal(machineOffline.status, "offline", "an unreachable machine is reported live and always applies");
  assert.equal(machineOffline.offlineReason, "machine_offline");
  assert.equal(machineOffline.lastSeenAt, live.lastSeenAt, "its older clock does not rewind lastSeenAt");
  const back = mergeAgentInstancePresence(machineOffline, { ...live, status: "idle",
    lastSeenAt: "2026-10-02T08:30:00Z" });
  assert.equal(back.offlineReason, undefined);
  assert.equal(back.status, "idle");
});

{
  const { mergeAccountLevelLlmUsage } = functions;
  const sample = (at, percent, totalTokens) => ({ quotaSource: "provider_api", quotaObservedAt: at,
    quotaUsages: [{ label: "5h", percent }], totalTokens });
  const old = sample("2026-10-03T21:00:00Z", 99, 7);
  const fresh = sample("2026-10-03T21:01:00Z", 12, 9);
  const accepted = mergeAccountLevelLlmUsage(old, fresh);
  assert.equal(accepted.quotaUsages[0].percent, 12, "newer lower usage replaces the whole quota sample");
  const delayed = mergeAccountLevelLlmUsage(accepted, old);
  assert.equal(delayed.quotaUsages[0].percent, 12, "a delayed high reading cannot reverse it");
  assert.equal(delayed.quotaObservedAt, fresh.quotaObservedAt);
  assert.equal(delayed.totalTokens, 7, "Instance accounting is independent from quota ordering");
  assert.equal(mergeAccountLevelLlmUsage(accepted, { totalTokens: 11 }).quotaObservedAt, fresh.quotaObservedAt);
}

{
  const { mergeAccountLevelLlmUsage, mergeLlmUsagePreferringQuotas } = functions;
  const at = "2026-10-03T21:01:00Z";
  const observed = { totalTokens: 7, quotaSource: "provider_api", quotaObservedAt: at, quotaUsages: [{ label: "5h", percent: 99 }] };
  const expired = { quotaState: "unknown", quotaObservedAt: at };
  const cleared = mergeAccountLevelLlmUsage(observed, expired);
  assert.equal(cleared.quotaUsages, undefined);
  assert.equal(cleared.quotaState, "unknown");
  assert.equal(cleared.totalTokens, 7);
  assert.equal(mergeAccountLevelLlmUsage(cleared, observed).quotaUsages, undefined, "a delayed same-version reading cannot undo expiry");
  assert.equal(mergeLlmUsagePreferringQuotas(observed, expired).quotaUsages, undefined, "Instance merge honors the withdrawal too");
  assert.equal(mergeAccountLevelLlmUsage(cleared, { ...observed, quotaObservedAt: "2026-10-03T21:02:00Z" }).quotaUsages[0].percent, 99);
  const { agentMemberUsage } = functions;
  const presence = { usage: expired, instances: [{ id: "old", status: "busy", usage: observed }] };
  assert.equal(agentMemberUsage(presence).quotaUsages, undefined, "member display cannot restore an expired sibling meter via fallback");
  assert.equal(agentMemberUsage(presence).totalTokens, 7);
  const missing = { quotaState: "unknown" };
  assert.equal(mergeAccountLevelLlmUsage(missing, observed).quotaObservedAt, at);
  assert.equal(mergeAccountLevelLlmUsage(observed, missing).quotaObservedAt, at, "a delayed initial missing snapshot cannot erase the first reading");
  assert.equal(mergeLlmUsagePreferringQuotas(observed, missing).quotaUsages[0].percent, 99);
  assert.equal(agentMemberUsage({ ...presence, usage: missing }).quotaUsages[0].percent, 99);
}

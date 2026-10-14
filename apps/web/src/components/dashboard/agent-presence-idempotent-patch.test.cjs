const assert = require("node:assert/strict");
const test = require("node:test");
const { installTypeScriptRequire } = require("./typescript-require.cjs");
installTypeScriptRequire();
const { createRealtimeCollection } = require("./realtime-collection.ts");
const { loadWorkspaceShellModuleMap, loadShellFunctions } = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname, ["channel-viewer-state.ts", "channel-links.ts"]);

const PRESENCE_FUNCTIONS = [
  "timestampMs",
  "channelSortTimes",
  "channelSortTimestamps",
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

function countedChannelSpace(sameAgent = false) {
  let reads = 0;
  let idReads = 0;
  const channels = Array.from({ length: 1000 }, (_, index) => ({
    get id() { idReads += 1; return `channel-${index}`; },
    name: `conversation-${index}`,
    get memberPresence() {
      reads += 1;
      return { [`agent:${sameAgent ? 0 : index}`]: { kind: "agent", instances: [{
        ...workingInstance(), id: `instance-${index}`, channelId: `channel-${index}`,
      }] } };
    },
  }));
  return { channels, reads: () => reads, idReads: () => idReads };
}

for (const sameAgent of [false, true]) test(`a thousand reports route once (${sameAgent ? "one Agent" : "independent Agents"})`, () => {
  const counted = countedChannelSpace(sameAgent);
  const { channels } = counted;
  const reports = channels.map((channel, index) => ({
    ...heartbeatAgent(), id: `agent:${sameAgent ? 0 : index}`,
    usage: { quotaSource: "provider_api", quotaObservedAt: "2026-09-19T12:01:00.000Z",
      quotaUsages: [{ label: "5h", percent: 95 }] }, instances: [{
      ...workingInstance(), id: `instance-${index}`, channelId: channel.id, activity: "New activity",
    }],
  }));
  const updated = patchChannelsAgentPresenceBatch(channels, reports);
  assert.ok(counted.reads() < 20_000, `unrelated Channels were inspected ${counted.reads()} times`);
  updated.forEach((channel, index) => assert.equal(
    channel.memberPresence[`agent:${sameAgent ? 0 : index}`].instances[0].activity, "New activity"));
});


test("alternating cards and snapshots reuse routing without revisiting unrelated Channels", () => {
  const counted = countedChannelSpace();
  const { channels } = counted;
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
  assert.ok(counted.reads() < 5_000, `the alternating stream inspected unrelated presence ${counted.reads()} times`);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(updated[index].memberPresence[`agent:${index}`].instances[0].activity, `Step ${index}`);
  }
  assert.equal(updated[999], channels[999], "unreported Channels retain identity");
});

test("consecutive published runs do not reread unrelated Channel rosters", () => {
  const counted = countedChannelSpace();
  let channels = counted.channels;
  let previous;
  for (let index = 0; index < 100; index += 1) {
    const batch = createChannelPresenceBatch(channels, previous?.takeRouting(channels));
    batch.applyPresence([{ ...heartbeatAgent(), id: `agent:${index}`, instances: [{
      ...workingInstance(), id: `instance-${index}`, channelId: `channel-${index}`, activity: `Step ${index}`,
    }] }]);
    channels = batch.getCommit().items;
    previous = batch;
  }
  assert.ok(counted.reads() < 5_000, `separate flushes inspected unrelated presence ${counted.reads()} times`);
  assert.equal(channels[99].memberPresence["agent:99"].instances[0].activity, "Step 99");
  assert.equal(channels[999], counted.channels[999]);
});

test("keyed live runs reuse Channel positions without revisiting unrelated ids or rewriting previous snapshots", () => {
  const counted = countedChannelSpace();
  const store = createRealtimeCollection(counted.channels);
  const initialReads = counted.idReads();
  let previous;
  let firstPublished;
  for (let step = 0; step < 100; step += 1) {
    const basis = store.getSnapshot();
    const batch = createChannelPresenceBatch(basis, previous?.takeRouting(basis));
    const instance = { ...workingInstance(), id: `instance-${step}`, channelId: `channel-${step}`, activity: `Live ${step}` };
    batch.applyPresence([{ ...heartbeatAgent(), id: `agent:${step}`, instances: [instance] }]);
    batch.applyChannel({ id: instance.channelId, name: `conversation-${step}`, memberPresence: {
      [`agent:${step}`]: { kind: "agent", instances: [instance] },
    } });
    const updates = batch.getLiveUpdates();
    assert.equal(updates.length, 1);
    store.receive(updates, batch.acceptLiveSnapshot);
    assert.equal(batch.getSnapshot(), store.getSnapshot());
    if (!firstPublished) firstPublished = Object.freeze(store.getSnapshot());
    previous = batch;
  }
  assert.ok(counted.idReads() - initialReads < 4_000,
    `live flushes revisited ${counted.idReads() - initialReads} Channel ids`);
  assert.equal(store.get("channel-99").memberPresence["agent:99"].instances[0].activity, "Live 99");
  assert.equal(firstPublished[99], counted.channels[99]);
  assert.equal(firstPublished[0].memberPresence["agent:0"].instances[0].activity, "Live 0");
  assert.equal(store.getCatalogSnapshot(), counted.channels);
  assert.equal(store.getSnapshot()[999], counted.channels[999]);
});

test("a live seal publishes before subscribers and cannot inherit a later reentrant catalog write", () => {
  const store = createRealtimeCollection(channelsWithAgentPresence());
  const batch = createChannelPresenceBatch(store.getSnapshot());
  assert.throws(() => batch.acceptLiveSnapshot([]), /after sealing/);
  batch.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "Before message" }] }]);
  const updates = batch.getLiveUpdates();
  assert.throws(() => batch.applyChannel({ id: "late", name: "Late" }), /published presence batch/);
  let reentered = false;
  store.subscribeKey("channel-1", () => {
    assert.equal(batch.getSnapshot(), store.getSnapshot(), "the accepted snapshot is already visible at the state boundary");
    assert.equal(store.get("channel-1").memberPresence["agent:claude"].instances[0].activity, "Before message");
  });
  store.subscribe(() => {
    if (reentered) return;
    reentered = true;
    store.set(current => [...current, { id: "catalog-new", name: "Added synchronously" }]);
  });
  store.receive(updates, batch.acceptLiveSnapshot);
  const published = batch.getSnapshot();
  assert.notEqual(published, store.getSnapshot());
  assert.equal(published.length, 1);
  assert.equal(store.getSnapshot().length, 2);
  assert.throws(() => batch.acceptLiveSnapshot(store.getSnapshot()), /accepted once/);
  assert.equal(batch.getSnapshot(), published);
  assert.equal(batch.takeRouting(store.getSnapshot()), undefined, "later catalog data cannot inherit the old position/routes index");
  assert.equal(batch.takeRouting(published), undefined, "a rejected transfer cannot be replayed on the older basis");
});

test("a sorted indexed fallback retains its order and immutable Map through a later keyed live run", () => {
  const older = { ...channelsWithAgentPresence()[0], updatedAt: "2026-09-19T10:00:00.000Z" };
  const store = createRealtimeCollection([older]);
  const fallback = createChannelPresenceBatch(store.getSnapshot());
  fallback.applyPresence([heartbeatAgent()]);
  fallback.applyChannel({ id: "newer", name: "Newer", updatedAt: "2026-09-19T11:00:00.000Z" });
  assert.equal(fallback.getLiveUpdates(), undefined, "rank changes need the indexed fallback");
  const committed = fallback.getCommit();
  store.commit(committed, "live");
  assert.deepEqual([...committed.byId.keys()], ["newer", older.id]);
  const next = createChannelPresenceBatch(store.getSnapshot(), fallback.takeRouting(store.getSnapshot()));
  next.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "After fallback" }] }]);
  store.receive(next.getLiveUpdates(), next.acceptLiveSnapshot);
  assert.deepEqual(store.getSnapshot().map(channel => channel.id), ["newer", older.id]);
  assert.equal(store.get(older.id).memberPresence["agent:claude"].instances[0].activity, "After fallback");
  assert.equal(committed.byId.get(older.id).memberPresence["agent:claude"].instances[0].activity, undefined);
  assert.equal(committed.items[1].memberPresence["agent:claude"].instances[0].activity, undefined);
});

test("a same-length reorder between staging and receive discards old routing and cannot update its neighbor", () => {
  const channel = channelsWithAgentPresence()[0];
  const neighbor = { ...channel, id: "neighbor", name: "Neighbor", memberPresence: {
    "agent:other": { kind: "agent", instances: [{ ...workingInstance(), id: "other-instance", channelId: "neighbor", activity: "Neighbor activity" }] },
  } };
  const store = createRealtimeCollection([channel, neighbor]);
  const staged = createChannelPresenceBatch(store.getSnapshot());
  staged.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "Staged before reorder" }] }]);
  const updates = staged.getLiveUpdates();
  store.set(current => [current[1], current[0]]);
  store.receive(updates, staged.acceptLiveSnapshot);
  const published = store.getSnapshot();
  assert.equal(staged.getSnapshot(), published);
  assert.deepEqual(published.map(item => item.id), [neighbor.id, channel.id]);
  const routing = staged.takeRouting(published);
  assert.equal(routing, undefined, "matching output identity cannot validate indices built before a different receive baseline");
  const next = createChannelPresenceBatch(published, routing);
  const report = { ...workingInstance(), activity: "After reorder" };
  delete report.channelId;
  next.applyPresence([{ ...heartbeatAgent(), id: "different-principal", instances: [report] }]);
  store.receive(next.getLiveUpdates(), next.acceptLiveSnapshot);
  assert.deepEqual(store.getSnapshot().map(item => item.id), [neighbor.id, channel.id]);
  assert.equal(store.get(channel.id).memberPresence["agent:claude"].instances[0].activity, "After reorder");
  assert.equal(store.get(neighbor.id), neighbor);
  assert.equal(neighbor.memberPresence["agent:other"].instances[0].activity, "Neighbor activity");
});

test("routing transfers once and rebuilds after a catalog replacement or cleared session", () => {
  const first = createChannelPresenceBatch(channelsWithAgentPresence());
  first.applyPresence([heartbeatAgent()]);
  const published = first.getCommit();
  const second = createChannelPresenceBatch(published.items, first.takeRouting(published.items));
  assert.equal(first.takeRouting(published.items), undefined, "a routing index has only one successor");
  assert.throws(() => second.applyChannel({ ...published.items[0], memberPresence: {
    malformed: { kind: "agent", instances: {} },
  } }), /Invalid realtime Instance collection/);
  second.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "After rejection" }] }]);
  const next = second.getCommit();
  assert.equal(next.items[0].memberPresence["agent:claude"].instances[0].activity, "After rejection");
  const replacement = [{ ...next.items[0], memberPresence: {
    replacement: { kind: "agent", instances: [{ ...workingInstance(), id: "catalog-instance" }] },
  } }];
  const routing = second.takeRouting(replacement);
  assert.equal(routing, undefined, "an external catalog write cannot inherit the old routes");
  const third = createChannelPresenceBatch(replacement, routing);
  const report = { ...workingInstance(), id: "catalog-instance", activity: "New catalog Run" };
  delete report.channelId;
  third.applyPresence([{ ...heartbeatAgent(), id: "different-principal", instances: [report] }]);
  const current = third.getCommit();
  assert.equal(current.items[0].memberPresence.replacement.instances[0].activity, "New catalog Run");
  assert.equal(third.takeRouting([]), undefined, "an account reset discards routing");
  assert.equal(third.takeRouting(current.items), undefined, "a rejected basis cannot be replayed later");
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
  const published = batch.getCommit();
  const beforeMessage = published.items;
  assert.deepEqual(beforeMessage.map(channel => channel.id), ["channel-2", "channel-1"]);
  assert.equal(batch.getSnapshot(), beforeMessage, "the transferred snapshot stays stable");
  assert.throws(() => batch.applyPresence([{ ...heartbeatAgent(), instances: [{
    ...workingInstance(), activity: "Cannot rewrite published state",
  }] }]), /published presence batch/);
  assert.equal(published.byId.get(older.id).memberPresence["agent:claude"].instances[0].activity,
    "Before message", "a completed batch cannot mutate the published key index");
  const after = createChannelPresenceBatch(beforeMessage);
  after.applyPresence([{ ...heartbeatAgent(), instances: [{ ...workingInstance(), activity: "After message" }] }]);
  assert.equal(beforeMessage[1].memberPresence["agent:claude"].instances[0].activity, "Before message");
  assert.equal(after.getSnapshot()[1].memberPresence["agent:claude"].instances[0].activity, "After message");
});

test("an inherited sidebar order keeps stable ties when a Channel changes rank and returns", () => {
  const first = { id: "first", name: "same", updatedAt: "2026-09-19T10:00:00.000Z" };
  const second = { ...first, id: "second" };
  const initial = createChannelPresenceBatch([first, second]);
  initial.applyPresence([heartbeatAgent()]);
  initial.applyChannel({ ...first, id: "third" });
  const published = initial.getCommit();
  const next = createChannelPresenceBatch(published.items, initial.takeRouting(published.items));
  next.applyChannel({ ...first, updatedAt: "2026-09-19T11:00:00.000Z" });
  next.applyChannel(first);
  next.applyChannel({ ...first, id: "fourth" });
  assert.deepEqual(next.getCommit().items.map(channel => channel.id), ["first", "second", "third", "fourth"]);
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


test("malformed snapshots are rejected before indexing and cannot poison later batches", () => {
  const channel = channelsWithAgentPresence()[0];
  const malformed = { id: "malformed-channel", name: "Malformed", memberPresence: {
    malformed: { kind: "agent", instances: {} },
  } };
  const first = createChannelPresenceBatch([channel]);
  assert.throws(() => first.applyChannel(malformed), /Invalid realtime Instance collection/);
  assert.deepEqual(first.getSnapshot(), [channel]);
  const later = createChannelPresenceBatch(first.getSnapshot());
  const report = { ...workingInstance(), activity: "Next batch still works" };
  later.applyPresence([{ ...heartbeatAgent(), instances: [report] }]);
  assert.equal(later.getSnapshot()[0].memberPresence["agent:claude"].instances[0].activity, report.activity);
  const legacy = createChannelPresenceBatch([malformed, channel]);
  legacy.applyPresence([{ ...heartbeatAgent(), instances: [report] }]);
  assert.equal(legacy.getSnapshot()[1].memberPresence["agent:claude"].instances[0].activity, report.activity);
});

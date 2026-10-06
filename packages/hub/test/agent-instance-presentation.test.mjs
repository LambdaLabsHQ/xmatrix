import assert from "node:assert/strict";

import { test } from "node:test";

import {
  agentMessagePresentation,
  agentRuntimePresentation,
  mergeAgentInstancePresentation,
} from "../src/runtime-transport/agent-instance-presentation.ts";

test("generic runtime presentation excludes source fingerprints and execution history", () => {
  const state = agentRuntimePresentation({ status: "running", activeMessageId: "message",
    execution: { executionId: "task", sources: [{ bodyHash: "PRIVATE_SOURCE_HASH" }] },
    recentExecutions: [{ sources: [{ messageId: "PRIVATE_MESSAGE" }] }] });
  assert.deepEqual(state, { status: "running", activeMessageId: "message" });
});

test("runtime issues and advisories preserve only their typed public summaries", () => {
  for (const kind of ["retrying", "failed", "stalled"]) {
    assert.deepEqual(agentRuntimePresentation({status:"running", issue:{kind,sinceMillis:123, message:"PRIVATE_ERROR",rawPreview:"PRIVATE_PAYLOAD"}}), {status:"running",issue:{kind,sinceMillis:123}});
  }
  for (const severity of ["info", "warning", "error", "unknown"]) {
    assert.deepEqual(agentRuntimePresentation({status:"idle", notice:{severity,sinceMillis:123,title:"PRIVATE_TITLE",description:"PRIVATE_DESCRIPTION"}}), {status:"idle",notice:{severity,sinceMillis:123}});
  }
  for (const issue of [{kind:"network",sinceMillis:1},{kind:"failed"},{kind:"retrying",sinceMillis:-1},{kind:"failed",sinceMillis:1.2}, "failed"]) {
    assert.deepEqual(agentRuntimePresentation({status:"running",issue}), {status:"running"});
  }
  for (const notice of [{severity:"custom",sinceMillis:1},{severity:"warning"},{severity:"error",sinceMillis:-1},"error"]) {
    assert.deepEqual(agentRuntimePresentation({status:"running",notice}), {status:"running"});
  }
  const current = mergeAgentInstancePresentation(undefined, {type:"presence_update", status:"busy", intent:"keep this task", runtimeState:{status:"running",issue:{kind:"retrying",sinceMillis:123}}});
  const recovered = mergeAgentInstancePresentation(current, {type:"presence_update", runtimeState:{status:"running"}});
  assert.equal(recovered.intent, "keep this task");
  assert.equal(recovered.runtimeState.issue, undefined);
});

test("a runtime's wait passes through bounded, and a malformed one is dropped", () => {
  const label = "C".repeat(200);
  assert.deepEqual(
    agentRuntimePresentation({ status: "running", waiting: { kind: "tool", label, sinceMillis: 1_700_000_000_000, command: "gh pr checks --watch" } }),
    { status: "running", waiting: { kind: "tool", label: "C".repeat(160), sinceMillis: 1_700_000_000_000 } },
  );
  assert.deepEqual(
    agentRuntimePresentation({ status: "idle", waiting: { kind: "background", sinceMillis: 5 } }),
    { status: "idle", waiting: { kind: "background", sinceMillis: 5 } },
  );
  // The rest of what the harness says: at most four details, each bounded.
  assert.deepEqual(
    agentRuntimePresentation({ status: "idle", waiting: { kind: "background", sinceMillis: 5,
      details: [" Watch CI for PR #3781 ", "", 7, "D".repeat(400), "c", "d", "e"] } }),
    { status: "idle", waiting: { kind: "background", sinceMillis: 5,
      details: ["Watch CI for PR #3781", "D".repeat(300)] } },
  );
  for (const waiting of [{ kind: "human", sinceMillis: 5 }, { kind: "tool" }, { kind: "tool", sinceMillis: -1 }, "tool"]) {
    assert.deepEqual(agentRuntimePresentation({ status: "running", waiting }), { status: "running" });
  }
  // A status update without runtime state ends the wait with the turn.
  const waiting = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    status: "busy",
    runtimeState: { status: "running", waiting: { kind: "tool", label: "CI", sinceMillis: 5 } },
  });
  assert.equal(waiting.runtimeState.waiting.label, "CI");
  assert.equal(mergeAgentInstancePresentation(waiting, { type: "presence_update", status: "idle" })?.runtimeState, undefined);
});
import {
  parseAgentInstanceHibernationAttachment,
  serializeAgentInstanceHibernationAttachment,
} from "../src/runtime-transport/agent-instance-hibernation.ts";
import {
  overlayAgentPresenceOnChannel,
  serializeAgentFromSession,
} from "../src/runtime-transport/agent-instance-live-presentation.ts";
import { agentMessagePresentationForLiveSnapshot, overlayChannelsWithLiveAgentPresence } from "../src/runtime-transport/agent-presence-snapshot.ts";
import {
  createHumanPresenceFanout,
} from "../src/runtime-transport/human-presence-fanout.ts";
import {
  channelForSharedPresenceFanout,
} from "../src/runtime-transport/human-live-presence.ts";
import { loadChannelAgentPresence } from "../../db/src/channel-agent-presence.ts";

function runtimeSession(presentation) {
  return {
    principal: {
      ownerUserId: "user-1",
      agentId: "agent-1",
      agentName: "Codex",
      spaceId: "space-1",
      runId: "run-1",
      executionKey: "execution-1",
      channelId: "channel-1",
      machineId: "machine-1",
      hostId: "host-1",
    },
    run: {
      runId: "run-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      executionKey: "execution-1",
      channelId: "channel-1",
      channelInstanceId: "7",
      machineId: "machine-1",
      hostId: "host-1",
      cwd: "C:\\repo",
      status: "running",
      instanceStatus: "busy",
    },
    connectedAt: "2026-07-30T08:00:00.000Z",
    lastSeenAt: "2026-07-30T08:01:00.000Z",
    ...(presentation ? { presentation } : {}),
  };
}

function fullPresentation() {
  return mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    status: "busy",
    activity: "Implementing migration parity",
    files: ["packages/hub/src/scoped-control-authority-base.ts"],
    intent: "Restore labels",
    gitBranch: "fix/restore-agent-migration-labels",
    capabilities: ["chat", "tools"],
    runtimeState: {
      status: "running",
      activeChannelId: "channel-1",
      activeMessageId: "message-1",
    },
    goal: {
      active: true,
      objective: "Restore Agent presentation",
      status: "active",
      tokensUsed: 120,
    },
    model: "gpt-5",
    models: [{
      id: "gpt-5",
      model: "gpt-5",
      displayName: "GPT-5",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    }],
    effort: "high",
    commands: [{ token: "/model", label: "Model", mode: "typed", argumentSource: "agent-models" }],
    statusChips: [
      { id: "model", label: "Model", value: "gpt-5", source: "codex" },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      quotaSource: "provider_api",
      quotaUsages: [{
        label: "5h",
        window: "5h",
        used: 30,
        limit: 100,
        remaining: 70,
        percent: 30,
      }],
    },
  });
}

test("quota observations retain provider time across heartbeats and cannot borrow time for new unmarked windows", () => {
  const observedAt = "2026-09-19T20:00:00.000Z";
  const first = mergeAgentInstancePresentation(undefined, { type: "presence_update", usage: {
    quotaSource: "provider_api", quotaObservedAt: observedAt, quotaUsages: [{ label: "5h", percent: 80 }],
  } });
  const heartbeat = mergeAgentInstancePresentation(first, { type: "presence_update", usage: { inputTokens: 100 } });
  assert.equal(heartbeat.usage.quotaObservedAt, observedAt);
  const unmarked = mergeAgentInstancePresentation(heartbeat, { type: "presence_update", usage: {
    quotaSource: "provider_api", quotaUsages: [{ label: "5h", percent: 90 }],
  } });
  assert.equal(unmarked.usage.quotaObservedAt, undefined);
});

test("out-of-order quota frames retain the newer observation and accept subsequent recovery", () => {
  const observation = (time, percent, totalTokens) => ({ type: "presence_update", usage: {
    quotaSource: "provider_api", quotaObservedAt: time,
    quotaUsages: [{ label: "1w", percent }], totalTokens,
  } });
  const exhausted = mergeAgentInstancePresentation(undefined, observation("2026-09-21T18:30:00Z", 100, 10));
  const stale = mergeAgentInstancePresentation(exhausted, observation("2026-09-21T18:00:00Z", 20, 200));
  assert.equal(stale.usage.quotaUsages[0].percent, 100);
  assert.equal(stale.usage.quotaObservedAt, "2026-09-21T18:30:00Z");
  assert.equal(stale.usage.totalTokens, 200);
  const recovered = mergeAgentInstancePresentation(stale, observation("2026-09-22T02:31:00+08:00", 10, 300));
  assert.equal(recovered.usage.quotaUsages[0].percent, 10);
});

test("presence patches preserve all Agent labels and quota windows across token-only heartbeats", () => {
  const presentation = fullPresentation();
  const heartbeat = mergeAgentInstancePresentation(presentation, {
    type: "presence_update",
    usage: {
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    },
  });

  assert.equal(heartbeat.gitBranch, "fix/restore-agent-migration-labels");
  assert.equal(heartbeat.goal.objective, "Restore Agent presentation");
  assert.equal(heartbeat.model, "gpt-5");
  assert.equal(heartbeat.effort, "high");
  assert.equal(heartbeat.models[0].displayName, "GPT-5");
  assert.equal(heartbeat.commands[0].token, "/model");
  assert.deepEqual(heartbeat.files, ["packages/hub/src/scoped-control-authority-base.ts"]);
  assert.equal(heartbeat.statusChips[0].value, "gpt-5");
  assert.equal(heartbeat.statusChips[1].value, "high");
  assert.equal(heartbeat.usage.totalTokens, 180);
  assert.equal(heartbeat.usage.quotaUsages[0].remaining, 70);
});

test("usage heartbeats retire stale mirrored quota and context chips", () => {
  const presentation = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    status: "busy",
    model: "gpt-5",
    statusChips: [
      { id: "model", label: "Model", value: "gpt-5", source: "codex" },
      { id: "quota:5h", label: "5h", percent: 100, source: "codex" },
      { id: "ctx", label: "ctx", percent: 100, source: "codex" },
      { id: "mode", label: "Mode", value: "full access", source: "codex" },
    ],
    usage: {
      quotaSource: "provider_api",
      quotaUsages: [{ label: "5h", window: "Codex", percent: 100 }],
      contextUsagePercent: 100,
    },
  });

  const heartbeat = mergeAgentInstancePresentation(presentation, {
    type: "presence_update",
    usage: {
      quotaSource: "provider_api",
      quotaUsages: [{ label: "5h", window: "Codex", percent: 2 }],
      contextUsagePercent: 2,
    },
  });

  assert.equal(heartbeat.usage.quotaUsages[0].percent, 2);
  assert.equal(heartbeat.usage.contextUsagePercent, 2);
  assert.equal(heartbeat.statusChips.some((chip) => chip.id === "quota:5h"), false);
  assert.equal(heartbeat.statusChips.some((chip) => chip.id === "ctx"), false);
  assert.equal(heartbeat.statusChips.find((chip) => chip.id === "model").value, "gpt-5");
  assert.equal(heartbeat.statusChips.find((chip) => chip.id === "mode").value, "full access");
});

test("Agent presentation survives bounded hibernation with its required authority route", () => {
  const session = runtimeSession(fullPresentation());
  const serialized = serializeAgentInstanceHibernationAttachment(session);
  const restored = parseAgentInstanceHibernationAttachment(serialized);

  assert.equal(restored.session.presentation.gitBranch, "fix/restore-agent-migration-labels");
  assert.equal(restored.session.presentation.statusChips[1].value, "high");
  assert.equal(restored.session.presentation.usage.quotaUsages[0].window, "5h");
  assert.equal(restored.session.principal.spaceId, "space-1");
  assert.ok(new TextEncoder().encode(JSON.stringify(serialized)).byteLength <= 4_096);

  const systemSession = runtimeSession();
  systemSession.run.channelDeliveryEnabled = false;
  const restoredSystem = parseAgentInstanceHibernationAttachment(
    serializeAgentInstanceHibernationAttachment(systemSession),
  );
  assert.equal(restoredSystem.session.run.channelDeliveryEnabled, false);

});

test("Human channel presence and Agent peer cards receive the full live presentation", () => {
  const session = runtimeSession(fullPresentation());
  const channel = presentationChannel("migration", {
      "agent-1": {
        kind: "agent",
        label: "Codex",
        usage: fullPresentation().usage,
        email: "codex@example.com",
        avatarUrl: "https://example.com/codex.png",
        registration: { ownerUserId: "user-1", machineId: "machine-1", harness: "codex" },
        instances: [],
      },
    });
  const overlaid = overlayAgentPresenceOnChannel(channel, {
    reason: "update",
    session,
    status: "busy",
  });
  const presence = overlaid.memberPresence["agent-1"];
  const instance = presence.instances[0];

  assert.equal(presence.usage.totalTokens, 120);
  assert.equal(presence.goal.objective, "Restore Agent presentation");
  // A live frame never drops the member's registration identity.
  assert.deepEqual(presence.registration, { ownerUserId: "user-1", machineId: "machine-1", harness: "codex" });
  // channelInstanceId ordinals collide across sibling thread channels; every
  // live instance card must self-describe its owning channel scope.
  assert.equal(instance.channelId, "channel-1");
  assert.equal(instance.gitBranch, "fix/restore-agent-migration-labels");
  assert.equal(instance.model, "gpt-5");
  assert.equal(instance.effort, "high");
  assert.equal(instance.statusChips[0].label, "Model");
  assert.equal(instance.usage.quotaUsages[0].percent, 30);

  const peer = serializeAgentFromSession(session);
  assert.equal(peer.model, "gpt-5");
  assert.equal(peer.usage.totalTokens, 120);
  assert.equal(peer.instances[0].commands[0].token, "/model");
  assert.equal(peer.instances[0].channelId, "channel-1");
});

/** user-1 focuses channel-1, which reads as `channel`; returns what the fanout delivered. */
async function focusChannelOne(channel, live) {
  const handler = createHumanPresenceFanout({
    readChannel: async () => ({ channel, openChannelHumanMemberIdsBySpace: {} }),
  });
  const delivered = [];
  await handler({
    reason: "focus",
    previousFocusedChannelId: null,
    nextFocusedChannelId: "channel-1",
    session: { user: { id: "user-1" } },
    ...live,
    deliver(userId, message) {
      delivered.push({ userId, message });
    },
  });
  return delivered;
}

test("initial focused-channel fanout includes each live Agent presentation", async () => {
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    name: "migration",
    mode: "closed",
    visibleHumanMemberIds: ["user:user-1"],
    memberPresence: {
      "agent-1": {
        kind: "agent",
        label: "Codex",
        usage: fullPresentation().usage,
        instances: [{
          id: "instance-1",
          channelInstanceId: "7",
          connectedAt: "2026-07-30T08:00:00.000Z",
          lastSeenAt: "2026-07-30T08:00:00.000Z",
          status: "online",
        }],
      },
    },
    createdBy: "user-1",
    createdAt: "2026-07-30T07:00:00.000Z",
    updatedAt: "2026-07-30T07:00:00.000Z",
  };
  const delivered = await focusChannelOne(channel, {
    liveSessions: [{
      userId: "user-1",
      lastSeenAt: "2026-07-30T08:01:00.000Z",
      focusedChannelId: "channel-1",
    }],
    liveAgentSessions: [{
      ownerUserId: "user-1",
      agentId: "agent-1",
      agentName: "Codex",
      runId: "run-1",
      instanceId: "instance-1",
      channelId: "channel-1",
      channelInstanceId: "7",
      machineId: "machine-1",
      hostId: "host-1",
      status: "busy",
      connectedAt: "2026-07-30T08:00:00.000Z",
      lastSeenAt: "2026-07-30T08:01:00.000Z",
      presentation: fullPresentation(),
    }],
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].userId, "user-1");
  const instance = delivered[0].message.channel.memberPresence["agent-1"].instances[0];
  assert.equal(instance.statusChips[1].value, "high");
  assert.equal(instance.usage.quotaUsages[0].label, "5h");
});

test("shared Human presence fanout cannot publish one viewer's private Channel state", async () => {
  const attention = {
    channelId: "channel-1",
    unreadAttentionCount: 1,
    updatedAt: "2026-08-21T06:00:00.000Z",
  };
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    name: "mentions",
    mode: "closed",
    visibleHumanMemberIds: ["user:user-1", "user:user-2"],
    attention,
    readSequence: 8,
    createdBy: "user-1",
    createdAt: "2026-08-21T05:00:00.000Z",
    updatedAt: "2026-08-21T06:00:00.000Z",
  };
  const delivered = await focusChannelOne(channel, {
    liveSessions: [{
      userId: "user-1",
      lastSeenAt: "2026-08-21T06:00:00.000Z",
      focusedChannelId: "channel-1",
    }, {
      userId: "user-2",
      lastSeenAt: "2026-08-21T06:00:01.000Z",
      focusedChannelId: null,
    }],
    liveAgentSessions: [],
  });

  assert.deepEqual(delivered.map(({ userId }) => userId).sort(), ["user-1", "user-2"]);
  for (const { message } of delivered) {
    assert.equal(message.type, "channel_updated");
    assert.equal("attention" in message.channel, false);
    assert.equal("readSequence" in message.channel, false);
  }
  assert.equal(channel.attention, attention, "the personalized Authority snapshot stays immutable");
});

test("the shared presence serializer drops only viewer-scoped fields", () => {
  const attention = {
    channelId: "channel-1",
    unreadAttentionCount: 1,
    updatedAt: "2026-08-21T06:00:00.000Z",
  };
  const channel = {
    id: "channel-1",
    attention,
    readSequence: 4,
    memberReadSequences: { "user:user-1": 4 },
    memberPresence: { "user:user-1": { kind: "user", status: "online" } },
  };

  assert.deepEqual(channelForSharedPresenceFanout(channel), {
    id: "channel-1",
    memberReadSequences: { "user:user-1": 4 },
    memberPresence: { "user:user-1": { kind: "user", status: "online" } },
  });
});

test("Agent messages capture immutable goal, branch, model, effort, and chip snapshots", () => {
  assert.deepEqual(agentMessagePresentation(fullPresentation()), {
    goal: {
      active: true,
      objective: "Restore Agent presentation",
      status: "active",
      tokensUsed: 120,
    },
    gitBranch: "fix/restore-agent-migration-labels",
    model: "gpt-5",
    effort: "high",
    statusChips: [
      { id: "model", label: "Model", value: "gpt-5", source: "codex" },
      { id: "effort", label: "Effort", value: "high" },
    ],
  });
});

/** The live snapshot of a runtime session, without its presentation. */
function liveSnapshot(session) {
  return {
    ownerUserId: session.principal.ownerUserId,
    agentId: session.principal.agentId,
    agentName: session.principal.agentName,
    runId: session.principal.runId,
    instanceId: session.run.instanceId,
    channelId: session.run.channelId,
    channelInstanceId: session.run.channelInstanceId,
    machineId: session.run.machineId,
    hostId: session.run.hostId,
    status: session.run.instanceStatus,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
  };
}

test("an Agent append keeps stable identity before any optional presentation arrives", () => {
  const session = runtimeSession();
  const snapshot = agentMessagePresentationForLiveSnapshot(liveSnapshot(session));

  assert.deepEqual(snapshot, {
    identityId: "agent-1",
    kind: "agent",
    agentId: "agent-1",
    label: "Codex:7",
    name: "Codex",
    agentName: "Codex",
    userId: "user-1",
    instanceId: "instance-1",
    channelInstanceId: "7",
    instanceLabel: "Codex:7",
  });
});

test("Grok Build monthly credit quota survives presence merge and Human agent cards", () => {
  const presentation = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    status: "idle",
    activity: "待命",
    model: "grok-4",
    usage: {
      quotaSource: "provider_api",
      quotaUsages: [{
        label: "1mo",
        window: "grok",
        used: 82434,
        limit: 150000,
        remaining: 67566,
        percent: (82434 / 150000) * 100,
        resetAt: "2026-08-01T00:00:00+00:00",
      }],
    },
  });
  // Token-only heartbeat must not drop the monthly credit window.
  const heartbeat = mergeAgentInstancePresentation(presentation, {
    type: "presence_update",
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
  });
  assert.equal(heartbeat.usage.quotaUsages[0].label, "1mo");
  assert.equal(heartbeat.usage.quotaUsages[0].window, "grok");
  assert.equal(heartbeat.usage.quotaUsages[0].remaining, 67566);
  assert.equal(heartbeat.usage.totalTokens, 16);

  const session = runtimeSession(heartbeat);
  session.principal.agentName = "Grok";
  session.principal.agentId = "grok-1";
  session.run.agentId = "grok-1";
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    name: "grok-usage",
    mode: "open",
    memberPresence: { "grok-1": { kind: "agent", usage: heartbeat.usage, instances: [] } },
    createdBy: "user-1",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
  const overlaid = overlayAgentPresenceOnChannel(channel, {
    reason: "update",
    session,
    status: "idle",
  });
  const presence = overlaid.memberPresence["grok-1"];
  assert.equal(presence.usage.quotaUsages[0].label, "1mo");
  assert.equal(presence.instances[0].usage.quotaUsages[0].percent, (82434 / 150000) * 100);

  // enhanced_presence Human card (Room parity) carries the same meters.
  const peer = serializeAgentFromSession(session, heartbeat, "idle");
  assert.equal(peer.usage.quotaUsages[0].window, "grok");
  assert.equal(peer.instances[0].usage.quotaUsages[0].label, "1mo");
});

test("session-provided quota meter tags are discarded in favor of provider API usage", () => {
  const presentation = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    status: "busy",
    model: "claude-opus-5",
    statusChips: [
      // Meter-only tag: no text to show, just the numbers the client formats.
      {
        id: "quota:5h",
        label: "5h",
        percent: 2,
        resetAt: "2026-08-04T17:59:59.627274+00:00",
        source: "claude",
      },
      // Out of contract range: clamped rather than dropped.
      { id: "ctx", label: "ctx", percent: 140, source: "claude" },
      // Nothing to show at all.
      { id: "empty", label: "Empty" },
    ],
  });

  const chips = presentation.statusChips;
  assert.equal(chips.some((chip) => chip.id === "quota:5h"), false);
  assert.equal(chips.find((chip) => chip.id === "ctx").percent, 100);
  assert.equal(chips.find((chip) => chip.id === "empty"), undefined);
  assert.equal(chips.find((chip) => chip.id === "model").value, "claude-opus-5");

  // Message headers likewise exclude quota presentation hints.
  const snapshot = agentMessagePresentation(presentation);
  assert.equal(snapshot.statusChips.some((chip) => chip.id === "quota:5h"), false);
});

test("unmarked session quota is removed from retained presentation and live serialization", () => {
  const legacy = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    status: "busy",
    statusChips: [{ id: "quota:5h", label: "5h", percent: 100, source: "codex" }],
    usage: {
      inputTokens: 10,
      quotaUsages: [{ label: "5h", window: "Codex", percent: 100 }],
    },
  });
  assert.equal(legacy.usage.inputTokens, 10);
  assert.equal(legacy.usage.quotaUsages, undefined);
  assert.equal(legacy.statusChips?.some((chip) => chip.id.startsWith("quota:")) ?? false, false);

  const online = mergeAgentInstancePresentation(legacy, {
    type: "presence_update",
    usage: {
      quotaSource: "provider_api",
      quotaUsages: [{ label: "5h", window: "Codex", percent: 7 }],
    },
  });
  assert.equal(online.usage.quotaSource, "provider_api");
  assert.equal(online.usage.quotaUsages[0].percent, 7);

  const serialized = serializeAgentFromSession(runtimeSession({
    usage: {
      quotaUsages: [{ label: "5h", window: "Codex", percent: 100 }],
    },
    statusChips: [{ id: "quota:5h", label: "5h", percent: 100 }],
  }));
  assert.equal(serialized.usage?.quotaUsages, undefined);
  assert.equal(
    serialized.instances[0].statusChips?.some((chip) => chip.id.startsWith("quota:")) ?? false,
    false,
  );
});

test("channel agent presence keeps original birth connectedAt across reborn", () => {
  const birth = "2026-07-30T08:00:00.000Z";
  const channel = presentationChannel("agents-order", {
      "agent-1": {
        kind: "agent",
        label: "Codex",
        instances: [{
          id: "instance-old",
          channelInstanceId: "1",
          channelId: "channel-1",
          label: "Codex:1",
          connectedAt: birth,
          lastSeenAt: birth,
          status: "offline",
        }],
      },
    });

  const reborn = runtimeSession({ activity: "Thinking" });
  reborn.run.instanceId = "instance-new";
  reborn.run.channelInstanceId = "1";
  reborn.connectedAt = "2026-07-30T10:00:00.000Z";
  reborn.lastSeenAt = "2026-07-30T10:00:00.000Z";

  const overlaid = overlayAgentPresenceOnChannel(channel, {
    reason: "connect",
    session: reborn,
    status: "busy",
  });
  const instances = overlaid.memberPresence["agent-1"].instances;
  assert.equal(instances.length, 1);
  assert.equal(instances[0].id, "instance-new");
  assert.equal(instances[0].channelInstanceId, "1");
  assert.equal(
    instances[0].connectedAt,
    birth,
    "reborn must keep the channel slot birth clock so Agents list order does not jump",
  );
});

test("channel agent presence orders instances by birth connectedAt not lastSeen", () => {
  const channel = presentationChannel("agents-order", {
      "agent-1": {
        kind: "agent",
        label: "Codex",
        instances: [],
      },
    });

  const older = runtimeSession({ activity: "older" });
  older.run.instanceId = "instance-older";
  older.run.channelInstanceId = "1";
  older.connectedAt = "2026-07-30T08:00:00.000Z";
  older.lastSeenAt = "2026-07-30T08:00:00.000Z";

  const newer = runtimeSession({ activity: "newer" });
  newer.run.instanceId = "instance-newer";
  newer.run.channelInstanceId = "2";
  newer.connectedAt = "2026-07-30T09:00:00.000Z";
  newer.lastSeenAt = "2026-07-30T12:00:00.000Z";

  let next = overlayAgentPresenceOnChannel(channel, {
    reason: "connect",
    session: newer,
    status: "busy",
  });
  next = overlayAgentPresenceOnChannel(next, {
    reason: "connect",
    session: older,
    status: "idle",
  });
  // A late activity bump on the newer slot must not move it ahead of birth order.
  newer.lastSeenAt = "2026-07-30T13:00:00.000Z";
  next = overlayAgentPresenceOnChannel(next, {
    reason: "update",
    session: newer,
    status: "busy",
  });

  const ids = next.memberPresence["agent-1"].instances.map((instance) => instance.id);
  assert.deepEqual(ids, ["instance-older", "instance-newer"]);
});

test("disconnect overlay drops the last live Instance so the Agent is no longer Online", () => {
  const current = runtimeSession();
  current.run.kind = "channel-instance";
  const channel = {
    id: "channel-1",
    spaceId: "space-1",
    name: "pg",
    mode: "open",
    memberPresence: {
      "agent-1": {
        kind: "agent",
        label: "grok-daniel-windows",
        lastSeenAt: "2026-09-11T09:14:04.037Z",
        instances: [{
          id: "instance-1",
          channelInstanceId: "2",
          channelId: "channel-1",
          label: "grok-daniel-windows:2",
          connectedAt: "2026-09-11T09:13:28.326Z",
          lastSeenAt: "2026-09-11T09:14:04.037Z",
          status: "online",
        }],
      },
    },
    createdBy: "user-1",
    createdAt: "2026-09-10T20:17:39.913Z",
    updatedAt: "2026-09-11T09:14:04.037Z",
  };
  const overlaid = overlayAgentPresenceOnChannel(channel, {
    reason: "disconnect",
    session: current,
  });
  assert.equal(overlaid.memberPresence["agent-1"], undefined);
});

test("live overlay does not resurrect Instances Authority already dropped", () => {
  const channel = {
    id: "channel-1",
    name: "general",
    mode: "open",
    spaceId: "space-1",
    createdAt: "2026-07-30T07:00:00.000Z",
    updatedAt: "2026-07-30T07:00:00.000Z",
    memberPresence: {},
  };
  const [overlaid] = overlayChannelsWithLiveAgentPresence([channel], [{
    ownerUserId: "user-1",
    agentId: "agent-1",
    agentName: "Codex",
    runId: "run-1",
    instanceId: "instance-1",
    channelId: "channel-1",
    machineId: "machine-1",
    hostId: "host-1",
    status: "online",
    connectedAt: "2026-07-30T08:00:00.000Z",
    lastSeenAt: "2026-07-30T08:01:00.000Z",
  }]);
  assert.deepEqual(overlaid.memberPresence, {});
});

test("Cursor placeholder model ids and default Agent mode are dropped from presence", () => {
  const presentation = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    model: "default[]",
    statusChips: [
      { id: "model", label: "Model", value: "default[]" },
      { id: "mode", label: "Mode", value: "Agent" },
    ],
  });
  assert.equal(presentation?.model, undefined);
  assert.equal(presentation?.statusChips, undefined);
});

test("non-default Cursor mode chips survive presence presentation", () => {
  const presentation = mergeAgentInstancePresentation(undefined, {
    type: "presence_update",
    model: "Composer 2.5",
    statusChips: [
      { id: "model", label: "Model", value: "Composer 2.5" },
      { id: "mode", label: "Mode", value: "Plan" },
    ],
  });
  assert.equal(presentation?.model, "Composer 2.5");
  assert.deepEqual(
    new Set(presentation?.statusChips?.map((chip) => `${chip.id}:${chip.value}`)),
    new Set(["model:Composer 2.5", "mode:Plan"]),
  );
});

test('model catalog observation time changes only when a catalog is reported', () => {
  const first = mergeAgentInstancePresentation(undefined, { models: [{ id: 'actual-model', model: 'actual-model' }] });
  assert.ok(Number.isFinite(Date.parse(first.modelsObservedAt)));
  const heartbeat = mergeAgentInstancePresentation(first, { status: 'idle' });
  assert.equal(heartbeat.modelsObservedAt, first.modelsObservedAt);
  const cleared = mergeAgentInstancePresentation(first, { models: [] });
  assert.equal(cleared?.modelsObservedAt, undefined);
});

test("registration catalog and live presence retain one card per Instance through disconnect", async () => {
  const rows = [3, 4].map(ordinal => ({
    instance_id: `instance-${ordinal}`, channel_id: "channel-1", channel_instance_id: ordinal,
    status: "online", created_at: "2026-09-24T09:00:00Z", updated_at: "2026-09-24T09:01:00Z", registration_owner: "owner-1", registration_machine: "machine-1",
    registration_harness: "claude", workspace_machine_id: "machine-1",
    workspace_canonical_cwd: "/workspace", run_metadata_json: { identityKind: "instance" },
    profile_name: "Claude", profile_runtime: "claude", profile_metadata_json: {}, owner_email: null,
  }));
  const catalog = await loadChannelAgentPresence({ async query(statement) {
    return statement.name === "channel_agent_resting_presence_v4" ? [] : rows;
  } }, "space-1", ["channel-1"]);
  let channel = { id: "channel-1", memberPresence: catalog.get("channel-1") };
  const sessions = rows.map(row => ({
    ownerUserId: "owner-1", agentId: row.instance_id, agentName: "Claude",
    runId: `run-${row.channel_instance_id}`, instanceId: row.instance_id,
    channelId: "channel-1", channelInstanceId: String(row.channel_instance_id),
    machineId: "machine-1", hostId: "host-1", cwd: "/workspace", status: "idle",
    connectedAt: row.created_at, lastSeenAt: "2026-09-24T09:02:00Z",
    presentation: { model: "claude", gitBranch: "fix-presence" },
  }));
  for (let refresh = 0; refresh < 2; refresh++) {
    [channel] = overlayChannelsWithLiveAgentPresence([channel], sessions);
    const instances = Object.values(channel.memberPresence).flatMap(p => p.instances);
    assert.equal(instances.length, 2);
    assert.deepEqual(instances.map(i => i.id).sort(), ["instance-3", "instance-4"]);
    assert.ok(instances.every(i => i.status === "idle" && i.model === "claude"));
  }
  channel = overlayAgentPresenceOnChannel(channel, {
    reason: "disconnect",
    session: { principal: { agentId: "instance-3" }, run: { instanceId: "instance-3" } },
  });
  assert.deepEqual(Object.keys(channel.memberPresence), ["instance-4"]);
});

test("parameter snapshots survive reconnect and withdraw removed or malformed choices", () => {
  const parameters = [{ id: "future-speed", label: "Speed", options: ["turbo", "steady"], currentValue: "steady" }];
  const first = mergeAgentInstancePresentation(undefined, { type: "presence_update", model: "m1", parameters });
  const heartbeat = mergeAgentInstancePresentation(first, { type: "presence_update", activity: "working" });
  assert.deepEqual(heartbeat.parameters, parameters);
  assert.equal(heartbeat.parametersObservedAt, first.parametersObservedAt);
  const restored = parseAgentInstanceHibernationAttachment(serializeAgentInstanceHibernationAttachment(runtimeSession(heartbeat)));
  assert.deepEqual(restored.session.presentation.parameters, parameters);
  assert.deepEqual(serializeAgentFromSession(runtimeSession(heartbeat)).instances[0].parameters, parameters);
  assert.deepEqual(mergeAgentInstancePresentation(first, { type: "presence_update", parameters: [] }).parameters, []);
  assert.deepEqual(mergeAgentInstancePresentation(first, { type: "presence_update", model: "m2" }).parameters, []);
  const invalid = mergeAgentInstancePresentation(first, { type: "presence_update", parameters: [{ ...parameters[0], command: "sh" }] });
  assert.deepEqual(invalid.parameters, []);
  assert.ok(invalid.parametersObservedAt);
});

test("only registry-listed parameters become tags, under the registry's name", () => {
  const parameters = [
    { id: "fast", label: "Fast mode", options: ["on", "off"], currentValue: "on" },
    { id: "outputStyle", label: "Output style", kind: "enum", options: ["default", "Concise"], currentValue: "default" },
    { id: "future-switch", label: "Future", options: ["true", "false"], currentValue: "true" },
    { id: "mode", label: "Mode", options: ["plan", "code"], currentValue: "plan" },
  ];
  const first = mergeAgentInstancePresentation(undefined, { type: "presence_update", model: "m1", parameters,
    statusChips: [{ id: "mode", label: "Mode", value: "plan" }] });
  const chips = first.statusChips.filter(chip => chip.id.startsWith("parameter:"));
  // Discovered but unlisted parameters (output style, future switches) never become tags.
  assert.deepEqual(chips, [{ id: "parameter:fast", label: "Fast", value: "Fast", parameterKind: "boolean" }]);
  assert.deepEqual(first.statusChips.filter(chip => chip.id.endsWith("mode")).map(chip => chip.id), ["mode"]);
  // Fresh runtime chips without a catalog keep the last derived tags.
  const chipsOnly = mergeAgentInstancePresentation(first, { type: "presence_update", statusChips: [] });
  assert.ok(chipsOnly.statusChips.some(chip => chip.id === "parameter:fast"));
  // A listed switch shows nothing while off.
  const off = mergeAgentInstancePresentation(first, { type: "presence_update",
    parameters: [{ ...parameters[0], currentValue: "off" }] });
  assert.ok(!off.statusChips?.some(chip => chip.id === "parameter:fast"));
  // A model switch withdraws the model-bound catalog and its tags.
  assert.ok(!mergeAgentInstancePresentation(first, { type: "presence_update", model: "m2" })
    .statusChips?.some(chip => chip.id.startsWith("parameter:")));
  const restored = parseAgentInstanceHibernationAttachment(serializeAgentInstanceHibernationAttachment(runtimeSession(first)));
  assert.ok(restored.session.presentation.statusChips.some(chip => chip.parameterKind === "boolean"));
});

test("a listed switch carries its notice and stands in for the parameter it spells", () => {
  const parameters = [
    { id: "serviceTier", label: "Service tier", kind: "enum", options: ["priority", "default"],
      choices: [{ value: "priority", label: "Fast" }, { value: "default", label: "Standard" }], currentValue: "priority" },
    { id: "fast", label: "Fast mode", kind: "boolean", options: ["on", "off"], currentValue: "on", notice: "cooldown", aliasOf: "serviceTier" },
  ];
  const chips = mergeAgentInstancePresentation(undefined, { type: "presence_update", parameters })
    .statusChips.filter(chip => chip.id.startsWith("parameter:"));
  assert.deepEqual(chips, [{ id: "parameter:fast", label: "Fast", value: "Fast · cooldown", parameterKind: "boolean" }]);
  const aliasOff = mergeAgentInstancePresentation(undefined, { type: "presence_update",
    parameters: [parameters[0], { ...parameters[1], currentValue: "off" }] });
  assert.equal(aliasOff.statusChips, undefined);
});

test("unlisted parameter tags from older snapshots are dropped, and only a listed alias covers its target", () => {
  const legacy = { id: "parameter:outputStyle", label: "Output style", value: "default", parameterKind: "enum" };
  const fast = { id: "parameter:fast", label: "Fast", value: "Fast", parameterKind: "boolean" };
  // A stored presentation carried over without a catalog keeps only listed tags.
  const carried = mergeAgentInstancePresentation({ statusChips: [legacy, fast] }, { type: "presence_update", activity: "working" });
  assert.deepEqual(carried.statusChips.map(chip => chip.id), ["parameter:fast"]);
  const omitted = mergeAgentInstancePresentation({ statusChips: [legacy, fast] }, { type: "presence_update", statusChips: [] });
  assert.deepEqual(omitted.statusChips.map(chip => chip.id), ["parameter:fast"]);
  // An unlisted provider alias of Fast cannot hide the listed Fast tag.
  const shadow = mergeAgentInstancePresentation(undefined, { type: "presence_update", parameters: [
    { id: "fast", label: "Fast", kind: "boolean", options: ["on", "off"], currentValue: "on" },
    { id: "turbo", label: "Turbo", kind: "boolean", options: ["on", "off"], currentValue: "on", aliasOf: "fast" },
  ] });
  assert.deepEqual(shadow.statusChips.map(chip => chip.id), ["parameter:fast"]);
});

test("a listed choice shows its value's display label, its default included, but never a pending selection", () => {
  // The registry lists the native id `fast`; a harness may report it as a choice.
  const choice = { id: "fast", label: "Speed", kind: "enum", options: ["default", "priority"],
    choices: [{ value: "default", label: "Standard" }, { value: "priority", label: "Priority" }] };
  const atDefault = mergeAgentInstancePresentation(undefined, { type: "presence_update",
    parameters: [{ ...choice, currentValue: "default" }] });
  assert.deepEqual(atDefault.statusChips, [{ id: "parameter:fast", label: "Fast", value: "Standard", parameterKind: "enum" }]);
  const pending = mergeAgentInstancePresentation(undefined, { type: "presence_update", parameters: [choice] });
  assert.equal(pending.statusChips, undefined);
});

test("runtime presence accepts a missing hostname but still requires exact Machine and Run identities", async () => {
  const { loadLiveAgentPresenceFromRuntime } = await import("../src/runtime-transport/agent-presence-snapshot.ts");
  const snapshot = { ownerUserId: "owner", agentId: "instance", agentName: "Agent", runId: "run",
    instanceId: "instance", channelId: "channel", machineId: "machine", status: "idle",
    connectedAt: "2026-10-03T00:00:00Z", lastSeenAt: "2026-10-03T00:00:00Z" };
  const runtime = value => ({ fetch: async () => Response.json({ sessions: [value] }) });
  assert.equal((await loadLiveAgentPresenceFromRuntime(runtime(snapshot), "https://runtime.test"))[0].hostId, "");
  for (const field of ["machineId", "runId", "instanceId", "channelId"]) {
    assert.deepEqual(await loadLiveAgentPresenceFromRuntime(runtime({ ...snapshot, [field]: undefined,
      hostname: "same-name" }), "https://runtime.test"), []);
  }
});

function presentationChannel(name, memberPresence) {
  return { id: "channel-1", spaceId: "space-1", name, mode: "open", memberPresence,
    createdBy: "user-1", createdAt: "2026-07-30T07:00:00.000Z", updatedAt: "2026-07-30T07:00:00.000Z" };
}

test("a focus change refreshes only the Channels it left and opened; a connect refreshes every watched one", async () => {
  const live = {
    liveAgentSessions: [],
    liveSessions: [
      { userId: "user-1", lastSeenAt: "2026-10-05T00:00:00.000Z", focusedChannelId: "channel-2" },
      { userId: "user-2", lastSeenAt: "2026-10-05T00:00:00.000Z", focusedChannelId: "watched-by-2" },
      { userId: "user-3", lastSeenAt: "2026-10-05T00:00:00.000Z", focusedChannelId: "watched-by-3" },
    ],
  };
  const fanout = async (reason, previousFocusedChannelId, nextFocusedChannelId) => {
    const read = [];
    await createHumanPresenceFanout({
      readChannel: async (channelId, _userId, purpose) => {
        read.push([channelId, purpose]);
        return undefined;
      },
    })({ reason, previousFocusedChannelId, nextFocusedChannelId, session: { user: { id: "user-1" } },
      ...live, deliver() {} });
    return read.sort();
  };
  assert.deepEqual(await fanout("focus", "channel-1", "channel-2"),
    [["channel-1", "human-presence"], ["channel-2", "human-presence"]]);
  assert.deepEqual((await fanout("connect", null, null)).map(([channelId]) => channelId),
    ["channel-2", "watched-by-2", "watched-by-3"]);
});

const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  mergeAgentTraceReplicas,
  visibleAgentTraceReplicasForHistoryReads,
} = require("./agent-trace-replica.ts");

function trace(
  id,
  channelId,
  instanceId,
  delta,
  channelInstanceId = instanceId,
  agentId = "agent:codex"
) {
  return {
    id,
    type: "observable_event",
    channelId,
    agentId,
    agentName: agentId,
    workspaceUserId: "owner",
    timestamp: `2026-05-23T00:00:0${id.slice(-1)}.000Z`,
    metadata: {
      eventType: "llm_trace",
      payload: {
        schemaVersion: 1,
        channelId,
        source: "codex_app_server",
        phase: "assistant_delta",
        agent: {
          id: agentId,
          instanceId,
          channelInstanceId,
          runtimeInstanceId: "runtime-shared",
        },
        payload: {
          threadId: "shared-thread",
          turnId: "shared-turn",
          delta,
        },
      },
    },
  };
}

test("mergeAgentTraceReplicas keeps channel instances in independent replicas", () => {
  const replicas = mergeAgentTraceReplicas([], [
    trace("e1", "channel-a", "1", "from a"),
    trace("e2", "channel-b", "1", "from b"),
    trace("e3", "channel-a", "2", "from a second instance"),
  ]);

  assert.deepEqual(
    replicas.map((replica) => replica.scope),
    [
      { channelId: "channel-a", agentId: "agent:codex", instanceId: "1" },
      { channelId: "channel-a", agentId: "agent:codex", instanceId: "2" },
      { channelId: "channel-b", agentId: "agent:codex", instanceId: "1" },
    ]
  );
  assert.deepEqual(replicas.map((replica) => replica.events.map((event) => event.id)), [["e1"], ["e3"], ["e2"]]);
});

test("mergeAgentTraceReplicas scopes by internal instance id instead of channel index", () => {
  const replicas = mergeAgentTraceReplicas([], [
    trace("e1", "channel-a", "instance-alpha", "from first run", "1"),
    trace("e2", "channel-a", "instance-beta", "from second run", "1"),
  ]);

  assert.deepEqual(
    replicas.map((replica) => replica.scope),
    [
      { channelId: "channel-a", agentId: "agent:codex", instanceId: "instance-alpha" },
      { channelId: "channel-a", agentId: "agent:codex", instanceId: "instance-beta" },
    ]
  );
  assert.deepEqual(replicas.map((replica) => replica.events.map((event) => event.id)), [["e1"], ["e2"]]);
});

test("mergeAgentTraceReplicas appends only to the matching instance replica", () => {
  const first = mergeAgentTraceReplicas([], [
    trace("e1", "channel-a", "1", "first"),
    trace("e2", "channel-a", "2", "second"),
  ]);
  const next = mergeAgentTraceReplicas(first, [
    trace("e3", "channel-a", "1", "first again"),
    trace("e2", "channel-a", "2", "second duplicate"),
    trace("e4", "channel-b", "1", "other channel"),
  ]);

  assert.deepEqual(
    next.map((replica) => ({
      scope: replica.scope,
      events: replica.events.map((event) => event.id),
    })),
    [
      {
        scope: { channelId: "channel-a", agentId: "agent:codex", instanceId: "1" },
        events: ["e1", "e3"],
      },
      {
        scope: { channelId: "channel-a", agentId: "agent:codex", instanceId: "2" },
        events: ["e2"],
      },
      {
        scope: { channelId: "channel-b", agentId: "agent:codex", instanceId: "1" },
        events: ["e4"],
      },
    ]
  );
});

test("live WebSocket events replace same-id history while late history cannot replace live data", () => {
  const historyEvent = trace("same", "channel-a", "instance-a", "history copy");
  const liveEvent = trace("same", "channel-a", "instance-a", "live copy");
  const fromHistory = mergeAgentTraceReplicas([], [historyEvent], { source: "history" });
  const liveWins = mergeAgentTraceReplicas(fromHistory, [liveEvent], { source: "live" });
  assert.equal(
    liveWins[0].events[0].metadata.payload.payload.delta,
    "live copy"
  );
  assert.deepEqual(liveWins[0].liveEventIds, ["same"]);

  const historyArrivesLate = mergeAgentTraceReplicas(liveWins, [historyEvent], { source: "history" });
  assert.equal(
    historyArrivesLate[0].events[0].metadata.payload.payload.delta,
    "live copy"
  );
  assert.deepEqual(historyArrivesLate[0].events.map((event) => event.id), ["same"]);
});

test("unavailable, expired, and rejected reads cannot render stale replica payload", () => {
  const replicas = mergeAgentTraceReplicas([], [
    trace("e1", "channel-a", "available", "visible"),
    trace("e2", "channel-a", "loading", "visible while loading"),
    trace("e3", "channel-a", "unavailable", "must disappear"),
    trace("e4", "channel-a", "expired", "must disappear"),
    trace("e5", "channel-a", "rejected", "must disappear"),
  ]);
  const visible = visibleAgentTraceReplicasForHistoryReads(replicas, [
    { instanceId: "available", phase: "available" },
    { instanceId: "loading", phase: "loading" },
    { instanceId: "unavailable", phase: "unavailable" },
    { instanceId: "expired", phase: "expired" },
    { instanceId: "rejected", phase: "error" },
  ]);
  assert.deepEqual(visible.map((replica) => replica.scope.instanceId), ["available", "loading"]);
});

test("an earlier history page merges below newer events and a cap keeps the newest", () => {
  const newest = mergeAgentTraceReplicas([], [trace("e8", "c1", "i1", "8"), trace("e9", "c1", "i1", "9")], {
    source: "history",
  });
  const withOlder = mergeAgentTraceReplicas(newest,
    [trace("e3", "c1", "i1", "3"), trace("e1", "c1", "i1", "1"), trace("e8", "c1", "i1", "late copy")],
    { source: "history" });
  assert.deepEqual(withOlder[0].eventIds, ["e1", "e3", "e8", "e9"]);
  assert.equal(withOlder[0].events[2].metadata.payload.payload.delta, "8", "late history never replaces");

  const capped = mergeAgentTraceReplicas(withOlder, [trace("e5", "c1", "i1", "5")], {
    source: "live", maxEventsPerReplica: 3,
  });
  assert.deepEqual(capped[0].eventIds, ["e5", "e8", "e9"]);
  assert.deepEqual(capped[0].liveEventIds, ["e5"]);
});

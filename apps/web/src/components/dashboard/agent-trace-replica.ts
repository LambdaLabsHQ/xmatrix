import { timestampMillisOrZero as timestampMs } from "./time-display";
import type { ObservabilityEvent } from "@xmatrix/protocol";

type AgentTraceScope = {
  channelId: string;
  agentId: string;
  instanceId: string;
};

export type AgentTraceReplica = {
  scope: AgentTraceScope;
  events: ObservabilityEvent[];
  eventIds: string[];
  liveEventIds: string[];
};

export type AgentTraceReplicaMergeOptions = {
  maxEventsPerReplica?: number;
  source?: "history" | "live";
};

export type AgentTraceReplicaPurgeBoundary = {
  agentId?: string;
  channelIds?: readonly string[];
  instanceIds?: readonly string[];
};

export type AgentTraceReplicaHistoryReadState = {
  instanceId: string;
  phase: "loading" | "available" | "unavailable" | "expired" | "error";
};

function emptyAgentTraceReplica(scope: AgentTraceScope): AgentTraceReplica {
  return {
    scope,
    events: [],
    eventIds: [],
    liveEventIds: [],
  };
}

/**
 * Merge a batch into per-scope replicas. A same-id live event replaces history;
 * late history never replaces live data. Each touched replica sorts once, so a
 * whole history page costs one sort rather than one per event.
 */
export function mergeAgentTraceReplicas(
  current: AgentTraceReplica[],
  incoming: ObservabilityEvent[],
  options: AgentTraceReplicaMergeOptions = {}
): AgentTraceReplica[] {
  const source = options.source || "live";
  const replicas = new Map<string, AgentTraceReplica>(
    current.map((replica) => [traceScopeKey(replica.scope), replica])
  );
  const touched = new Map<string, {
    scope: AgentTraceScope;
    byId: Map<string, ObservabilityEvent>;
    liveEventIds: Set<string>;
  }>();

  for (const event of incoming) {
    const scope = traceEventScope(event);
    if (!scope) continue;
    const key = traceScopeKey(scope);
    let draft = touched.get(key);
    if (!draft) {
      const replica = replicas.get(key) || emptyAgentTraceReplica(scope);
      draft = {
        scope: replica.scope,
        byId: new Map(replica.events.map((item) => [item.id, item])),
        liveEventIds: new Set(replica.liveEventIds || []),
      };
      touched.set(key, draft);
    }
    if (draft.byId.has(event.id) && (source === "history" || draft.liveEventIds.has(event.id))) continue;
    draft.byId.set(event.id, event);
    if (source === "live") draft.liveEventIds.add(event.id);
  }

  for (const [key, draft] of touched) {
    const events = Array.from(draft.byId.values()).sort(compareTraceEvents);
    replicas.set(key, trimAgentTraceReplica({
      scope: draft.scope,
      events,
      eventIds: events.map((item) => item.id),
      liveEventIds: Array.from(draft.liveEventIds).filter((eventId) => draft.byId.has(eventId)),
    }, options.maxEventsPerReplica));
  }

  return sortAgentTraceReplicas(Array.from(replicas.values()));
}

export function purgeAgentTraceReplicas(
  current: AgentTraceReplica[],
  boundary: AgentTraceReplicaPurgeBoundary
): AgentTraceReplica[] {
  const agentId = boundary.agentId?.trim();
  const channelIds = new Set((boundary.channelIds || []).filter(isNonEmptyString));
  const instanceIds = new Set((boundary.instanceIds || []).filter(isNonEmptyString));
  if (!agentId && channelIds.size === 0 && instanceIds.size === 0) return current;
  return current.filter((replica) => {
    if (agentId && replica.scope.agentId !== agentId) return true;
    if (channelIds.size > 0 && !channelIds.has(replica.scope.channelId)) return true;
    if (instanceIds.size > 0 && !instanceIds.has(replica.scope.instanceId)) return true;
    return false;
  });
}

/**
 * A Human reconnect invalidates third-party Channel-read evidence until the
 * host trace endpoint reauthorizes it. Keep only replicas whose every event is
 * owned by the reconnecting
 * user; missing or mixed ownership is treated as third-party and fails closed.
 */
export function purgeThirdPartyAgentTraceReplicas(
  current: AgentTraceReplica[],
  currentUserId: string
): AgentTraceReplica[] {
  const ownerUserId = currentUserId.trim();
  if (!ownerUserId) return [];
  return current.filter((replica) =>
    replica.events.length > 0 &&
    replica.events.every((event) => event.workspaceUserId === ownerUserId)
  );
}

export function visibleAgentTraceReplicasForHistoryReads(
  current: AgentTraceReplica[],
  reads: readonly AgentTraceReplicaHistoryReadState[]
): AgentTraceReplica[] {
  const unavailableInstanceIds = reads
    .filter((read) =>
      read.phase === "unavailable" || read.phase === "expired" || read.phase === "error"
    )
    .map((read) => read.instanceId);
  return purgeAgentTraceReplicas(current, { instanceIds: unavailableInstanceIds });
}

function sortAgentTraceReplicas(replicas: AgentTraceReplica[]): AgentTraceReplica[] {
  return replicas.sort((left, right) => {
    const byChannel = left.scope.channelId.localeCompare(right.scope.channelId);
    if (byChannel !== 0) return byChannel;
    const byAgent = left.scope.agentId.localeCompare(right.scope.agentId);
    if (byAgent !== 0) return byAgent;
    return left.scope.instanceId.localeCompare(right.scope.instanceId);
  });
}

function trimAgentTraceReplica(
  replica: AgentTraceReplica,
  maxEventsPerReplica: number | undefined
): AgentTraceReplica {
  if (!maxEventsPerReplica || replica.events.length <= maxEventsPerReplica) return replica;
  const events = replica.events.slice(-maxEventsPerReplica);
  const kept = new Set(events.map((event) => event.id));
  return {
    ...replica,
    events,
    eventIds: events.map((event) => event.id),
    liveEventIds: replica.liveEventIds.filter((eventId) => kept.has(eventId)),
  };
}

function traceScopeKey(scope: AgentTraceScope): string {
  return `${scope.channelId}:${scope.agentId}:${scope.instanceId}`;
}

function traceEventScope(event: ObservabilityEvent): AgentTraceScope | null {
  if (event.metadata?.eventType !== "llm_trace") return null;
  const channelId = event.channelId || tracePayloadChannelId(event);
  const agentId = event.agentId || event.targetAgentId || tracePayloadAgentId(event);
  const instanceId = traceEventChannelInstanceId(event);
  if (!channelId || !agentId || !instanceId) return null;
  return { channelId, agentId, instanceId };
}

export function traceEventChannelInstanceId(event: ObservabilityEvent): string | null {
  const agent = tracePayloadRecord(event)?.agent;
  if (!agent || typeof agent !== "object") return null;
  const agentRecord = agent as Record<string, unknown>;
  const instanceId = agentRecord.instanceId || agentRecord.channelInstanceId;
  return typeof instanceId === "string" && instanceId.trim() ? instanceId : null;
}

function compareTraceEvents(left: ObservabilityEvent, right: ObservabilityEvent): number {
  const byTime = timestampMs(left.timestamp) - timestampMs(right.timestamp);
  if (byTime !== 0) return byTime;
  return left.id.localeCompare(right.id);
}

function tracePayloadChannelId(event: ObservabilityEvent): string | undefined {
  const channelId = tracePayloadRecord(event)?.channelId;
  return typeof channelId === "string" && channelId.trim() ? channelId : undefined;
}

function tracePayloadAgentId(event: ObservabilityEvent): string | undefined {
  const agent = tracePayloadRecord(event)?.agent;
  if (!agent || typeof agent !== "object") return undefined;
  const id = (agent as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function tracePayloadRecord(event: ObservabilityEvent): Record<string, unknown> | null {
  const candidate: unknown = event.metadata?.payload;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as Record<string, unknown>;
}



function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

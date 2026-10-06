import { plainRecord } from "@xmatrix/protocol";
import type { AgentInstanceTraceHistoryResultMessage } from "@xmatrix/protocol/connections/agent-instance";
import { rfc3339TimestampEpochNanoseconds, type ObservabilityEvent , utf8ByteLength } from "@xmatrix/protocol";

/** One page. Older retained history is read through `before` cursors. */
export const AGENT_HOST_TRACE_MAX_EVENTS = 500;
export const AGENT_HOST_TRACE_MAX_RESPONSE_BYTES = 900 * 1024;
/**
 * Host-encoded budget asked of the Agent host. Canonicalization adds scope
 * fields to every event, so the Hub page is cut again at the response bound.
 */
export const AGENT_HOST_TRACE_PAGE_MAX_BYTES = 512 * 1024;
export const AGENT_HOST_TRACE_REQUEST_TIMEOUT_MS = 5_000;
/**
 * Longest a live `since` read may wait on the Agent host for a newer event.
 * Matches the host's own bound; the request timeout is extended by the wait.
 */
export const AGENT_HOST_TRACE_MAX_WAIT_MS = 25_000;
export const AGENT_HOST_TRACE_MAX_PENDING_REQUESTS = 64;
export const AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE = 8;
export const AGENT_HOST_TRACE_MAX_WAITERS_PER_KEY = 16;
export const AGENT_HOST_TRACE_MAX_TOTAL_WAITERS = 256;

/** Shared bounded accounting for the Runtime and legacy host request paths. */
export class AgentHostTraceRequestBudget {
  private readonly requests = new Map<string, { instanceId: string; waiters: number }>();
  private readonly requestsByInstance = new Map<string, number>();
  private totalWaiters = 0;

  tryStart(instanceId: string, requestId: string): boolean {
    if (this.requests.has(requestId) ||
        this.requests.size >= AGENT_HOST_TRACE_MAX_PENDING_REQUESTS ||
        (this.requestsByInstance.get(instanceId) ?? 0) >=
          AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE ||
        this.totalWaiters >= AGENT_HOST_TRACE_MAX_TOTAL_WAITERS) {
      return false;
    }
    this.requests.set(requestId, { instanceId, waiters: 1 });
    this.requestsByInstance.set(instanceId, (this.requestsByInstance.get(instanceId) ?? 0) + 1);
    this.totalWaiters += 1;
    return true;
  }

  tryJoin(requestId: string): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.waiters >= AGENT_HOST_TRACE_MAX_WAITERS_PER_KEY ||
        this.totalWaiters >= AGENT_HOST_TRACE_MAX_TOTAL_WAITERS) {
      return false;
    }
    request.waiters += 1;
    this.totalWaiters += 1;
    return true;
  }

  finish(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    this.totalWaiters = Math.max(0, this.totalWaiters - request.waiters);
    const remainingForInstance = (this.requestsByInstance.get(request.instanceId) ?? 1) - 1;
    if (remainingForInstance > 0) {
      this.requestsByInstance.set(request.instanceId, remainingForInstance);
    } else {
      this.requestsByInstance.delete(request.instanceId);
    }
  }
}

export type AgentHostTraceAvailability = "available" | "unavailable" | "expired";

export interface AgentHostTraceBinding {
  instanceId: string;
  ownerUserId: string;
  agentId: string;
  agentName: string;
  channelId: string;
  allowedChannelIds?: readonly string[];
  /** Legacy only: retain bounded host channels for mandatory per-event authorization. */
  deferChannelAuthorization?: boolean;
  runId: string;
  machineId: string;
  hostId: string;
  channelInstanceId?: string;
  channelInstanceIdByChannel?: Readonly<Record<string, string>>;
}

export interface AgentHostTraceReadResult {
  availability: AgentHostTraceAvailability;
  /** No older retained event remains and nothing was evicted. */
  complete: boolean;
  /** Newest first by (instant, id). */
  events: ObservabilityEvent[];
  /** Cursor for the next older page; null on the oldest or an unpaged read. */
  nextCursor?: string | null;
  reason?: "host_offline" | "host_timeout" | "host_expired" | "host_overloaded" |
    "invalid_host_response" | "host_paging_unsupported";
}

export interface AgentHostTraceReadRequest {
  maxEvents: number;
  since?: string;
  before?: string;
  /** Only with `since` and without `before`: wait up to this long for news. */
  waitMs?: number;
}

/** A wait is honoured only on a live delta and within the host's bound. */
export function agentHostTraceWaitMs(
  request: Pick<AgentHostTraceReadRequest, "since" | "before" | "waitMs">,
): number {
  const waitMs = request.waitMs ?? 0;
  if (!request.since || request.before || !Number.isSafeInteger(waitMs) || waitMs <= 0) return 0;
  return Math.min(waitMs, AGENT_HOST_TRACE_MAX_WAIT_MS);
}

export function unavailableAgentHostTrace(
  reason: AgentHostTraceReadResult["reason"] = "host_offline",
): AgentHostTraceReadResult {
  return { availability: "unavailable", complete: false, events: [], reason };
}

export function sanitizeAgentHostTraceHistory(
  message: AgentInstanceTraceHistoryResultMessage,
  binding: AgentHostTraceBinding,
  request: AgentHostTraceReadRequest,
): AgentHostTraceReadResult | undefined {
  try {
    const { maxEvents, since, before } = request;
    if (message.instanceId !== binding.instanceId) return undefined;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) return undefined;
    if (!Array.isArray(message.events)) return undefined;
    const sinceEpochNanoseconds = since === undefined
      ? undefined
      : boundedTimestamp(since)?.epochNanoseconds;
    if (since !== undefined && sinceEpochNanoseconds === undefined) return undefined;
    const beforeKey = before === undefined ? undefined : parseAgentHostTraceCursor(before);
    if (before !== undefined && beforeKey === undefined) return undefined;
    if (message.availability !== "available") {
      if (message.complete || message.events.length !== 0) return undefined;
      return message.availability === "expired"
        ? { availability: "expired", complete: false, events: [], nextCursor: null, reason: "host_expired" }
        : { ...unavailableAgentHostTrace(), nextCursor: null };
    }
    // A host that predates paging ignores `before` and would answer with the
    // newest page; never present that as older history.
    const pagingHost = message.nextCursor !== undefined;
    if (beforeKey && !pagingHost) {
      return { availability: "available", complete: false, events: [], nextCursor: null,
        reason: "host_paging_unsupported" };
    }
    const hostNextCursor = typeof message.nextCursor === "string"
      ? message.nextCursor
      : null;
    if (message.nextCursor !== undefined && message.nextCursor !== null &&
        (hostNextCursor === null || !parseAgentHostTraceCursor(hostNextCursor))) {
      return undefined;
    }
    if (message.events.length > AGENT_HOST_TRACE_MAX_EVENTS) return undefined;
    const allowedChannelIds = new Set(binding.allowedChannelIds ?? [binding.channelId]);
    const candidates: { event: ObservabilityEvent; key: AgentHostTraceCursorKey }[] = [];
    const seen = new Set<string>();
    for (const candidate of message.events) {
      const id = boundedString(candidate?.id, 160);
      const timestamp = boundedTimestamp(candidate?.timestamp);
      const channelId = boundedString(candidate?.channelId, 180);
      if (!id || !timestamp || !channelId || seen.has(id)) continue;
      seen.add(id);
      if (candidate.type !== "event_published" ||
          (!binding.deferChannelAuthorization && !allowedChannelIds.has(channelId))) continue;
      if (sinceEpochNanoseconds !== undefined &&
          timestamp.epochNanoseconds < sinceEpochNanoseconds) continue;
      const key = { epochNanoseconds: timestamp.epochNanoseconds, id };
      if (beforeKey && compareAgentHostTraceCursorKeys(key, beforeKey) >= 0) continue;
      const metadata = plainRecord(candidate.metadata);
      const payload = plainRecord(metadata?.payload);
      if (metadata?.eventType !== "llm_trace" || !payload) continue;
      candidates.push({
        key,
        event: {
          id,
          type: "event_published",
          workspaceUserId: binding.ownerUserId,
          agentId: binding.agentId,
          agentName: binding.agentName,
          channelId,
          metadata: {
            eventType: "llm_trace",
            payload: canonicalAgentHostTracePayload(payload, binding, channelId),
          },
          timestamp: timestamp.value,
        },
      });
    }
    candidates.sort((left, right) => compareAgentHostTraceCursorKeys(right.key, left.key));
    // Cut the page at an event boundary instead of rejecting it: an oversized
    // response used to make a busy Agent's whole trace unreadable.
    const pageLimit = Math.min(maxEvents, AGENT_HOST_TRACE_MAX_EVENTS);
    const events: ObservabilityEvent[] = [];
    let encodedBytes = 0;
    let truncated = false;
    let skipped = false;
    for (const { event } of candidates) {
      if (events.length >= pageLimit) {
        truncated = true;
        break;
      }
      const size = utf8ByteLength(JSON.stringify(event));
      if (encodedBytes + size > AGENT_HOST_TRACE_MAX_RESPONSE_BYTES) {
        // One event over the whole bound is skipped rather than stalling paging.
        if (events.length === 0) {
          skipped = true;
          continue;
        }
        truncated = true;
        break;
      }
      encodedBytes += size;
      events.push(event);
    }
    const oldest = events.at(-1);
    return {
      availability: "available",
      complete: message.complete && !truncated && !skipped && hostNextCursor === null &&
        events.length === message.events.length,
      events,
      nextCursor: truncated && oldest ? agentHostTraceCursor(oldest) : hostNextCursor,
    };
  } catch {
    return undefined;
  }
}

interface AgentHostTraceCursorKey {
  epochNanoseconds: bigint;
  id: string;
}

/** Same shape the Rust host emits: the oldest event of a page, `<timestamp>|<id>`. */
export function agentHostTraceCursor(event: Pick<ObservabilityEvent, "timestamp" | "id">): string {
  return `${event.timestamp}|${event.id}`;
}

export function parseAgentHostTraceCursor(value: unknown): AgentHostTraceCursorKey | undefined {
  if (typeof value !== "string" || value.length > 240) return undefined;
  const separator = value.indexOf("|");
  if (separator < 0) return undefined;
  const epochNanoseconds = agentHostTraceTimestampEpochNanoseconds(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (epochNanoseconds === undefined || !id || id.length > 160) return undefined;
  return { epochNanoseconds, id };
}

/** Code-unit order, matching the host's byte order for its ASCII event ids. */
function compareAgentHostTraceCursorKeys(
  left: AgentHostTraceCursorKey,
  right: AgentHostTraceCursorKey,
): number {
  if (left.epochNanoseconds !== right.epochNanoseconds) {
    return left.epochNanoseconds < right.epochNanoseconds ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function canonicalAgentHostTracePayload(
  payload: Record<string, unknown>,
  binding: AgentHostTraceBinding,
  channelId: string,
): Record<string, unknown> {
  const channelInstanceId = binding.channelInstanceIdByChannel &&
      Object.prototype.hasOwnProperty.call(binding.channelInstanceIdByChannel, channelId)
    ? binding.channelInstanceIdByChannel[channelId]
    : binding.channelInstanceId;
  const canonicalScope = {
    owner: binding.ownerUserId,
    user: binding.ownerUserId,
    ownerId: binding.ownerUserId,
    ownerUserId: binding.ownerUserId,
    workspaceUserId: binding.ownerUserId,
    userId: binding.ownerUserId,
    agentId: binding.agentId,
    targetAgentId: binding.agentId,
    instanceId: binding.instanceId,
    runtimeInstanceId: binding.instanceId,
    channelInstanceId,
    runId: binding.runId,
    channelId,
    machineId: binding.machineId,
    hostId: binding.hostId,
    // The trace binding has no workspace/Space authority. Never retain a
    // provider-supplied value that could be mistaken for one.
    workspaceId: undefined,
    spaceId: undefined,
  };
  return {
    ...payload,
    ...canonicalScope,
    scope: { ...plainRecord(payload.scope), ...canonicalScope },
    agent: {
      ...plainRecord(payload.agent),
      ...canonicalScope,
      id: binding.agentId,
      name: binding.agentName,
    },
  };
}


function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function boundedTimestamp(
  value: unknown,
): { value: string; epochNanoseconds: bigint } | undefined {
  if (typeof value !== "string") return undefined;
  const epochNanoseconds = agentHostTraceTimestampEpochNanoseconds(value);
  return epochNanoseconds === undefined ? undefined : { value, epochNanoseconds };
}

/** Exact timestamp profile shared with the Rust Agent host trace store. */
export function agentHostTraceTimestampEpochNanoseconds(value: unknown): bigint | undefined {
  return rfc3339TimestampEpochNanoseconds(value);
}

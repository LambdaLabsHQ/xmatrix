import { timestampMillisOrZero as timestampMs } from "./time-display";
import type { ChannelMessage, ObservabilityEvent } from "@xmatrix/protocol";

export type AgentTraceTargetLike = {
  id?: string;
  name: string;
  status?: string;
  activity?: string;
  connectedAt?: string;
  instanceIds?: string[];
  instanceScoped?: boolean;
};

type AgentTraceStreamSection = {
  timestamp: number;
  title: string;
  body: string;
  kind: AgentTraceTimelineItem["kind"];
  fields?: AgentTraceTimelineField[];
  blocks?: AgentTraceTimelineBlock[];
};

type TraceEventRecord = {
  event: ObservabilityEvent;
  timestamp: number;
  phase: string;
  payload: Record<string, unknown> | null;
  inner: Record<string, unknown> | null;
  sessionId: string;
  threadId: string;
  turnId: string;
};

type AgentTraceTurn = {
  key: string;
  startedAt: number;
  updatedAt: number;
  sections: AgentTraceStreamSection[];
  toolCalls: Map<string, AgentTraceStreamSection>;
  pendingOutput: string;
  pendingOutputStartedAt: number;
  pendingOutputSegmentKey: string;
  pendingRuntimeDelta: string;
  pendingRuntimeDeltaStartedAt: number;
  pendingRuntimeDeltaSegmentKey: string;
  pendingRuntimeDeltaTitle: string;
  pendingRuntimeDeltaKind: AgentTraceTimelineItem["kind"];
  pendingRuntimeDeltaFields?: AgentTraceTimelineField[];
  connectionRetrySection: AgentTraceStreamSection | null;
  connectionRetryCount: number;
};

export type AgentTraceTimelineItem = {
  timestamp: number;
  title: string;
  body: string;
  kind: "input" | "output" | "tool" | "error" | "status" | "runtime";
  fields?: AgentTraceTimelineField[];
  blocks?: AgentTraceTimelineBlock[];
};

export type AgentTraceTimelineField = {
  label: string;
  value: string;
};

export type AgentTraceTimelineBlock = {
  label: string;
  text: string;
  format: "text" | "json" | "diff";
  collapsed?: boolean;
};

export function buildAgentConversationTraceStream(
  history: ChannelMessage[],
  target: AgentTraceTargetLike,
  events: ObservabilityEvent[]
): string {
  void history;
  void target;
  const sections = buildAgentConversationTraceTimeline(history, target, events);

  return sections
    .map((section) => agentTraceSection(section.title, section.body))
    .filter(Boolean)
    .join("\n\n");
}

export function buildAgentConversationTraceTimeline(
  history: ChannelMessage[],
  target: AgentTraceTargetLike,
  events: ObservabilityEvent[]
): AgentTraceTimelineItem[] {
  void history;
  void target;
  const cached = timelineCache.get(events);
  if (cached) return cached;
  const items = buildAgentTraceSections(events)
    .filter((section) => section.body.trim())
    .map((section) => ({
      timestamp: section.timestamp,
      title: section.title,
      body: section.body,
      kind: section.kind,
      fields: section.fields,
      blocks: section.blocks,
    }));
  timelineCache.set(events, items);
  return items;
}

/*
 * The trace window rebuilds its timeline whenever the workspace re-renders or
 * a live page lands. Replicas keep the same events array until they change and
 * the same event objects across merges, so the work is cached at both levels:
 * an untouched replica costs a lookup, and a changed one re-parses no event it
 * has seen before (tool payloads are JSON-formatted once, not on every token).
 * Results are treated as immutable by every caller.
 */
const timelineCache = new WeakMap<readonly ObservabilityEvent[], AgentTraceTimelineItem[]>();
const turnsCache = new WeakMap<readonly ObservabilityEvent[], AgentTraceTurn[]>();
const recordCache = new WeakMap<ObservabilityEvent, TraceEventRecord>();
const sectionCache = new WeakMap<ObservabilityEvent, AgentTraceStreamSection | null>();

function buildAgentTraceSections(events: ObservabilityEvent[]): AgentTraceStreamSection[] {
  const sections: AgentTraceStreamSection[] = [];
  for (const turn of buildAgentTraceTurns(events)) {
    sections.push(...turn.sections);
  }
  return sections;
}

function buildAgentTraceTurns(events: ObservabilityEvent[]): AgentTraceTurn[] {
  const cached = turnsCache.get(events);
  if (cached) return cached;
  const built = buildAgentTraceTurnsUncached(events);
  turnsCache.set(events, built);
  return built;
}

function buildAgentTraceTurnsUncached(events: ObservabilityEvent[]): AgentTraceTurn[] {
  const turns = new Map<string, AgentTraceTurn>();
  let currentUnkeyedTurn = "";

  for (const record of traceEventRecords(events)) {
    const key = traceTurnKey(record, currentUnkeyedTurn);
    if (record.phase === "turn_started") {
      currentUnkeyedTurn = key;
    } else if (!currentUnkeyedTurn && isTraceDeltaPhase(record.phase)) {
      // Orphaned stream chunks (e.g. Grok ACP events that only carried sessionId,
      // or turn_started outside the visible scan window) still need a sticky turn
      // so one-token deltas do not each become a separate Output card.
      currentUnkeyedTurn = key;
    } else if (
      record.phase === "turn_completed" ||
      record.phase === "turn_failed" ||
      record.phase === "turn_cancelled"
    ) {
      currentUnkeyedTurn = "";
    }

    const turn = ensureTraceTurn(turns, key, record.timestamp);
    turn.startedAt = Math.min(turn.startedAt, record.timestamp);
    turn.updatedAt = Math.max(turn.updatedAt, record.timestamp);

    if (record.phase === "turn_started") {
      const input = readableTraceText(record.inner?.input);
      if (input) {
        turn.sections.push({
          timestamp: record.timestamp,
          title: "Input",
          body: input,
          kind: "input",
        });
      }
      continue;
    }

    const connectionRetry = connectionRetryTraceInfo(record);
    if (connectionRetry) {
      flushTraceOutput(turn);
      flushTraceRuntimeDelta(turn);
      appendConnectionRetrySection(turn, record, connectionRetry);
      continue;
    }
    const failureConsumedByConnectionSection = resolveConnectionRetrySection(turn, record);

    if (isTraceDeltaPhase(record.phase)) {
      flushTraceRuntimeDelta(turn);
      const segmentKey = traceDeltaSegmentKey(record);
      if (turn.pendingOutput && segmentKey && turn.pendingOutputSegmentKey && segmentKey !== turn.pendingOutputSegmentKey) {
        flushTraceOutput(turn);
      }
      if (!turn.pendingOutputStartedAt) turn.pendingOutputStartedAt = record.timestamp;
      if (segmentKey) turn.pendingOutputSegmentKey = segmentKey;
      turn.pendingOutput = appendTraceDelta(turn.pendingOutput, readableTraceDelta(traceDeltaValue(record.inner)));
      continue;
    }

    if (isRuntimeDeltaRecord(record)) {
      flushTraceOutput(turn);
      appendTraceRuntimeDelta(turn, record);
      continue;
    }

    if (record.phase === "turn_completed") {
      continue;
    }

    if (record.phase === "turn_failed") {
      flushTraceOutput(turn);
      flushTraceRuntimeDelta(turn);
      const error = normalizeTraceStreamText(readableTraceText(record.inner?.error));
      if (error && !failureConsumedByConnectionSection) {
        turn.sections.push({
          timestamp: record.timestamp,
          title: "Error",
          body: error,
          kind: "error",
        });
      }
      continue;
    }

    if (record.phase === "turn_cancelled") {
      flushTraceOutput(turn);
      flushTraceRuntimeDelta(turn);
      const cancelled = normalizeTraceStreamText(readableTraceText(record.inner?.reason ?? record.inner?.error));
      if (cancelled) {
        turn.sections.push({
          timestamp: record.timestamp,
          title: "Cancelled",
          body: cancelled,
          kind: "status",
        });
      }
      continue;
    }

    const section = cachedTraceRecordSection(record);
    if (section) {
      flushTraceOutput(turn);
      flushTraceRuntimeDelta(turn);
      // ACP emits one tool_call plus repeated tool_call_update frames for a
      // single invocation. Coalesce them by call id so the timeline shows one
      // summarized card that accumulates arguments, output, and final status
      // instead of one card per frame.
      const callKey = acpToolCallKey(record);
      const existing = callKey ? turn.toolCalls.get(callKey) : undefined;
      if (existing) {
        mergeToolTraceSection(existing, section);
      } else {
        if (callKey) turn.toolCalls.set(callKey, section);
        turn.sections.push(section);
      }
    }
  }

  const orderedTurns = Array.from(turns.values()).sort((left, right) => left.startedAt - right.startedAt);
  for (const turn of orderedTurns) {
    flushTraceRuntimeDelta(turn);
    flushTraceOutput(turn);
  }
  return orderedTurns;
}

function ensureTraceTurn(turns: Map<string, AgentTraceTurn>, key: string, timestamp: number): AgentTraceTurn {
  const existing = turns.get(key);
  if (existing) return existing;
  const turn: AgentTraceTurn = {
    key,
    startedAt: timestamp,
    updatedAt: timestamp,
    sections: [],
    toolCalls: new Map(),
    pendingOutput: "",
    pendingOutputStartedAt: 0,
    pendingOutputSegmentKey: "",
    pendingRuntimeDelta: "",
    pendingRuntimeDeltaStartedAt: 0,
    pendingRuntimeDeltaSegmentKey: "",
    pendingRuntimeDeltaTitle: "",
    pendingRuntimeDeltaKind: "runtime",
    connectionRetrySection: null,
    connectionRetryCount: 0,
  };
  turns.set(key, turn);
  return turn;
}

function flushTraceOutput(turn: AgentTraceTurn): void {
  const output = normalizeTraceStreamText(turn.pendingOutput);
  if (output) {
    turn.sections.push({
      timestamp: turn.pendingOutputStartedAt || turn.updatedAt,
      title: "Output",
      body: output,
      kind: "output",
    });
  }
  turn.pendingOutput = "";
  turn.pendingOutputStartedAt = 0;
  turn.pendingOutputSegmentKey = "";
}

function appendTraceRuntimeDelta(turn: AgentTraceTurn, record: TraceEventRecord): void {
  const segmentKey = traceRuntimeDeltaSegmentKey(record);
  if (
    turn.pendingRuntimeDelta &&
    segmentKey &&
    turn.pendingRuntimeDeltaSegmentKey &&
    segmentKey !== turn.pendingRuntimeDeltaSegmentKey
  ) {
    flushTraceRuntimeDelta(turn);
  }
  if (!turn.pendingRuntimeDeltaStartedAt) turn.pendingRuntimeDeltaStartedAt = record.timestamp;
  if (segmentKey) turn.pendingRuntimeDeltaSegmentKey = segmentKey;
  const structured = structuredRuntimeDeltaTrace(record);
  turn.pendingRuntimeDeltaTitle = tracePhaseTitle(record);
  turn.pendingRuntimeDeltaKind = traceRecordKind(record);
  turn.pendingRuntimeDeltaFields = structured.fields;
  turn.pendingRuntimeDelta = appendTraceDelta(turn.pendingRuntimeDelta, structured.body);
}

function flushTraceRuntimeDelta(turn: AgentTraceTurn): void {
  const body = normalizeTraceStreamText(turn.pendingRuntimeDelta);
  if (body) {
    turn.sections.push({
      timestamp: turn.pendingRuntimeDeltaStartedAt || turn.updatedAt,
      title: turn.pendingRuntimeDeltaTitle || "Runtime update",
      body,
      kind: turn.pendingRuntimeDeltaKind,
      fields: turn.pendingRuntimeDeltaFields,
    });
  }
  turn.pendingRuntimeDelta = "";
  turn.pendingRuntimeDeltaStartedAt = 0;
  turn.pendingRuntimeDeltaSegmentKey = "";
  turn.pendingRuntimeDeltaTitle = "";
  turn.pendingRuntimeDeltaKind = "runtime";
  turn.pendingRuntimeDeltaFields = undefined;
}

function traceTurnKey(record: TraceEventRecord, currentUnkeyedTurn: string): string {
  if (record.turnId || record.threadId) {
    return `${record.threadId || "thread"}:${record.turnId || "turn"}`;
  }
  if (record.phase === "turn_started") {
    return record.event.id;
  }
  if (currentUnkeyedTurn) {
    return currentUnkeyedTurn;
  }
  // Grok ACP historically only stamped sessionId. Group orphaned stream chunks by
  // session so each token does not become its own turn when turn_started is gone.
  if (record.sessionId) {
    return `session:${record.sessionId}:open`;
  }
  return record.event.id;
}

function traceEventRecords(events: ObservabilityEvent[]): TraceEventRecord[] {
  return events
    .map(traceEventRecord)
    .filter((record) => record.phase)
    .sort((left, right) => left.timestamp - right.timestamp || left.event.id.localeCompare(right.event.id));
}

function traceEventRecord(event: ObservabilityEvent): TraceEventRecord {
  const cached = recordCache.get(event);
  if (cached) return cached;
  const payload = tracePayloadRecord(event);
  const inner = traceInnerPayload(payload);
  const sessionId =
    stringTraceField(inner?.sessionId) ||
    stringTraceField(inner?.session_id) ||
    stringTraceField(payload?.sessionId) ||
    stringTraceField(payload?.session_id);
  const record: TraceEventRecord = {
    event,
    // Cached, so an undated event keeps one position (and one card key)
    // instead of moving to "now" on every rebuild.
    timestamp: timestampMs(event.timestamp) || Date.now(),
    phase: typeof payload?.phase === "string" ? payload.phase : "",
    payload,
    inner,
    sessionId,
    threadId: stringTraceField(inner?.threadId) || stringTraceField(payload?.threadId),
    turnId: stringTraceField(inner?.turnId) || stringTraceField(payload?.turnId),
  };
  recordCache.set(event, record);
  return record;
}

// Turn assembly mutates sections in place (tool-call merges, connection
// retries), so each build gets its own copy of the cached parse.
function cachedTraceRecordSection(record: TraceEventRecord): AgentTraceStreamSection | null {
  let section = sectionCache.get(record.event);
  if (section === undefined) {
    section = traceRecordSection(record);
    sectionCache.set(record.event, section);
  }
  return section ? { ...section } : null;
}

function stringTraceField(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function agentTraceSection(title: string, body: string): string {
  const text = normalizeTraceStreamText(body);
  return text ? `### ${title}\n\n${text}` : "";
}

export function buildAgentChannelMessageTraceStream(
  history: ChannelMessage[],
  target: AgentTraceTargetLike,
  since?: string
): string {
  const sinceTime = since ? new Date(since).getTime() : 0;
  const targetName = target.name.trim().toLowerCase();
  const messages = history
    .filter((message) => {
      if (message.from.kind !== "agent") return false;
      if (sinceTime && new Date(message.sentAt).getTime() < sinceTime) return false;
      if (target.instanceScoped && target.instanceIds?.length) {
        return Boolean(message.from.instanceId && target.instanceIds.includes(message.from.instanceId));
      }
      if (target.id && message.from.identityId === target.id) return true;
      if (message.from.label.trim().toLowerCase() === targetName) return true;
      if (message.from.agentName?.trim().toLowerCase() === targetName) return true;
      return false;
    })
    .sort((left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime())
    .map((message) => normalizeTraceStreamText(message.body))
    .filter(Boolean);

  return messages.join("\n\n");
}

export function buildAgentTraceStatusFallback(target: AgentTraceTargetLike): string {
  const lines = [
    target.activity || target.status ? `Status: ${target.activity || target.status}` : null,
    target.status && target.activity !== target.status ? `Presence: ${target.status}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

function tracePayloadRecord(event: ObservabilityEvent): Record<string, unknown> | null {
  const payload = event.metadata?.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function traceInnerPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const inner = payload?.payload;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

function traceRecordSection(record: TraceEventRecord): AgentTraceStreamSection | null {
  if (isSuppressedRuntimeTrace(record)) return null;
  const structured =
    record.phase === "runtime_event"
      ? structuredRuntimeTrace(record)
      : isToolTracePhase(record.phase)
        ? structuredToolTrace(record)
        : null;
  const body = structured?.body || readableTraceText(record.inner) || readableTraceText(record.payload);
  if (!body) return null;
  return {
    timestamp: record.timestamp,
    title: tracePhaseTitle(record),
    body,
    kind: traceRecordKind(record),
    fields: structured?.fields,
    blocks: structured?.blocks,
  };
}

type ConnectionRetryTraceInfo = {
  message: string;
  detail: string;
};

// Only ACP's correlated call ids qualify. Claude's stream-json uses `id` /
// `tool_use_id`, which must stay on their own cards.
function acpToolCallKey(record: TraceEventRecord): string {
  if (!isToolTracePhase(record.phase)) return "";
  const inner = record.inner || {};
  const item = traceObjectValue(inner.update) || traceObjectValue(inner.item) || inner;
  return (
    stringTraceField(item.toolCallId) ||
    stringTraceField(item.callId) ||
    stringTraceField(item.call_id) ||
    stringTraceField(inner.toolCallId) ||
    stringTraceField(inner.callId)
  );
}

function mergeToolTraceSection(
  target: AgentTraceStreamSection,
  incoming: AgentTraceStreamSection
): void {
  const fields = new Map<string, AgentTraceTimelineField>();
  for (const field of target.fields ?? []) {
    if (field.value) fields.set(field.label, field);
  }
  for (const field of incoming.fields ?? []) {
    if (!field.value) continue;
    // Keep the invocation's tool identity from the first frame; later
    // tool_call_update frames carry a per-command title that would replace it.
    if (field.label === "Tool" && fields.has("Tool")) continue;
    fields.set(field.label, field);
  }
  const blocks = new Map<string, AgentTraceTimelineBlock>();
  for (const block of [...(target.blocks ?? []), ...(incoming.blocks ?? [])]) {
    if (block.text) blocks.set(block.label, block);
  }
  target.fields = fields.size ? Array.from(fields.values()) : undefined;
  target.blocks = blocks.size ? Array.from(blocks.values()) : undefined;
  target.body = renderStructuredTraceBody(target.fields ?? [], target.blocks ?? []);
}

function connectionRetryTraceInfo(record: TraceEventRecord): ConnectionRetryTraceInfo | null {
  if (record.phase !== "runtime_event") return null;
  const inner = record.inner || {};
  const category = stringTraceField(inner.category);
  const details = traceObjectValue(inner.details);
  const errorRecord = traceObjectValue(inner.error) || traceObjectValue(details?.error);
  const message =
    stringTraceField(inner.message) ||
    stringTraceField(errorRecord?.message) ||
    stringTraceField(details?.message);
  const retrying = category === "connection" && stringTraceField(inner.status) === "retrying";
  // Older CLIs published transient reconnects as category=error/status=failed.
  const legacyReconnect = category === "error" && message.toLowerCase().startsWith("reconnecting...");
  if (!retrying && !legacyReconnect) return null;
  return {
    message: message || "Reconnecting…",
    detail: stringTraceField(errorRecord?.additionalDetails) || stringTraceField(details?.additionalDetails),
  };
}

function appendConnectionRetrySection(
  turn: AgentTraceTurn,
  record: TraceEventRecord,
  info: ConnectionRetryTraceInfo
): void {
  turn.connectionRetryCount += 1;
  const body = info.detail ? `${info.message} — ${info.detail}` : info.message;
  const fields = traceFields([
    ["Category", "connection"],
    ["Status", "retrying"],
    ["Attempts seen", String(turn.connectionRetryCount)],
  ]);
  if (turn.connectionRetrySection) {
    turn.connectionRetrySection.timestamp = record.timestamp;
    turn.connectionRetrySection.body = body;
    turn.connectionRetrySection.fields = fields;
    return;
  }
  const section: AgentTraceStreamSection = {
    timestamp: record.timestamp,
    title: "Connection reconnecting",
    body,
    kind: "status",
    fields,
  };
  turn.connectionRetrySection = section;
  turn.sections.push(section);
}

// After a reconnecting section, the next non-retry record resolves it: a
// turn failure becomes a terminal "Connection lost" (absorbing the error so
// it is not rendered twice), anything else means the stream recovered.
// Returns true when the record's failure was folded into the section.
function resolveConnectionRetrySection(turn: AgentTraceTurn, record: TraceEventRecord): boolean {
  const section = turn.connectionRetrySection;
  if (!section) return false;
  turn.connectionRetrySection = null;
  turn.connectionRetryCount = 0;
  if (record.phase === "turn_failed") {
    const error = normalizeTraceStreamText(readableTraceText(record.inner?.error));
    section.title = "Connection lost";
    section.kind = "error";
    section.timestamp = record.timestamp;
    section.body = [error || section.body, "Resend the message to retry."].filter(Boolean).join("\n");
    return true;
  }
  if (traceRecordKind(record) === "error") {
    // A fatal error right after reconnect attempts is not a recovery; the
    // error itself still renders as its own section.
    section.title = "Connection lost";
  } else if (record.phase !== "turn_cancelled") {
    section.title = "Connection restored";
  }
  return false;
}

export type AgentTraceHeaderStatus = {
  tone: "error" | "warning";
  title: string;
  detail: string;
};

const TRACE_HEADER_STATUS_DETAIL_LIMIT = 300;

// Terminal state of the turn with the latest activity, for surfacing on the
// instance window itself (outside the timeline): reconnecting while retries
// are in flight, failed once the turn ends in an error, cleared by any
// later activity (including the next turn).
export function buildAgentTraceHeaderStatus(events: ObservabilityEvent[]): AgentTraceHeaderStatus | null {
  let latest: AgentTraceTurn | null = null;
  for (const turn of buildAgentTraceTurns(events)) {
    if (!latest || turn.updatedAt >= latest.updatedAt) latest = turn;
  }
  const last = latest?.sections.at(-1);
  if (!last) return null;
  if (last.title === "Connection reconnecting") {
    return { tone: "warning", title: "Reconnecting", detail: truncateTraceHeaderDetail(last.body) };
  }
  if (last.kind === "error") {
    return {
      tone: "error",
      title: last.title === "Connection lost" ? "Connection lost" : "Last turn failed",
      detail: truncateTraceHeaderDetail(last.body),
    };
  }
  return null;
}

function truncateTraceHeaderDetail(value: string): string {
  const text = value.trim();
  if (text.length <= TRACE_HEADER_STATUS_DETAIL_LIMIT) return text;
  return `${text.slice(0, TRACE_HEADER_STATUS_DETAIL_LIMIT).trimEnd()}...`;
}

function isRuntimeDeltaRecord(record: TraceEventRecord): boolean {
  if (record.phase !== "runtime_event") return false;
  const inner = record.inner || {};
  if (isPatchDeltaRuntimeTrace(inner)) return false;
  return stringTraceField(inner.status) === "delta";
}

function isSuppressedRuntimeTrace(record: TraceEventRecord): boolean {
  if (record.phase !== "runtime_event") return false;
  const inner = record.inner || {};
  if (isPatchDeltaRuntimeTrace(inner)) return true;
  if (isRuntimeToolTrace(inner)) return false;
  const category = stringTraceField(inner.category);
  const status = stringTraceField(inner.status);
  if (category === "error" || status === "failed" || status === "cancelled") return false;

  const method = stringTraceField(inner.runtimeMethod);
  if (method.startsWith("turn/diff/")) return true;

  const details = traceObjectValue(inner.details);
  const itemType = stringTraceField(inner.itemType) || stringTraceField(inner.type) || stringTraceField(details?.type);
  if (method === "item/completed" && (itemType === "agentMessage" || itemType === "userMessage")) return true;
  if (category === "message" && (itemType === "agentMessage" || itemType === "userMessage")) return true;
  if (category === "turn" && (status === "info" || status === "completed")) return true;

  return false;
}

function structuredRuntimeTrace(record: TraceEventRecord): Pick<AgentTraceStreamSection, "body" | "fields" | "blocks"> {
  const inner = record.inner || {};
  if (isRuntimeToolTrace(inner)) return structuredToolTrace(record);
  if (stringTraceField(inner.category) === "reasoning") return structuredReasoningTrace(inner);
  const details = traceObjectValue(inner.details);

  const fields = traceFields([
    ["Summary", stringTraceField(inner.summary)],
    ["Method", stringTraceField(inner.runtimeMethod)],
    ["Category", stringTraceField(inner.category)],
    ["Status", stringTraceField(inner.status)],
    ["Message", stringTraceField(inner.message) || stringTraceField(details?.message)],
  ]);
  const blocks = traceBlocks([
    ["Error", inner.error ?? details?.error],
    ["Output", inner.output ?? inner.result ?? details?.output ?? details?.result],
    ["Details", inner.details],
  ]);

  return { body: renderStructuredTraceBody(fields, blocks), fields, blocks };
}

function structuredRuntimeDeltaTrace(record: TraceEventRecord): Pick<AgentTraceStreamSection, "body" | "fields"> {
  const inner = record.inner || {};
  const structured = isRuntimeToolTrace(inner) ? structuredToolTrace(record) : null;
  const fields =
    structured?.fields ||
    traceFields([
      ["Summary", stringTraceField(inner.summary)],
      ["Method", stringTraceField(inner.runtimeMethod)],
      ["Category", stringTraceField(inner.category)],
      ["Status", stringTraceField(inner.status)],
    ]);
  const body =
    readableTraceDelta(traceRuntimeDeltaValue(inner)) ||
    compactTraceText(structured?.body || readableTraceText(inner));
  return { body, fields };
}

function structuredReasoningTrace(inner: Record<string, unknown>): Pick<AgentTraceStreamSection, "body" | "fields" | "blocks"> {
  const status = stringTraceField(inner.status);
  const itemId = stringTraceField(inner.itemId);
  const fields = traceFields([
    ["Category", "reasoning"],
    ["Status", status],
    ["Item ID", itemId],
  ]);
  const body = ["Reasoning", status].filter(Boolean).join(" ");
  return { body, fields, blocks: [] };
}

function structuredToolTrace(record: TraceEventRecord): Pick<AgentTraceStreamSection, "body" | "fields" | "blocks"> {
  const inner = record.inner || {};
  const details = traceObjectValue(inner.details);
  const item = traceToolItem(inner, details);
  const action = traceObjectValue(item.action) || traceObjectValue(details?.action) || traceObjectValue(inner.action);
  const patch = tracePatchText(item, details);
  const fields = traceFields([
    ["Summary", stringTraceField(inner.summary)],
    ["Method", stringTraceField(inner.runtimeMethod)],
    ["Tool", traceToolName(item, inner)],
    [
      "Type",
      stringTraceField(item.type) ||
        stringTraceField(item.sessionUpdate) ||
        stringTraceField(inner.itemType) ||
        stringTraceField(inner.type),
    ],
    ["Kind", stringTraceField(item.kind)],
    ["Status", stringTraceField(item.status) || stringTraceField(inner.status)],
    [
      "Call ID",
      stringTraceField(item.callId) ||
        stringTraceField(item.toolCallId) ||
        stringTraceField(item.call_id) ||
        stringTraceField(item.tool_use_id) ||
        stringTraceField(details?.callId) ||
        stringTraceField(details?.call_id),
    ],
    ["Item ID", stringTraceField(inner.itemId) || stringTraceField(item.itemId) || stringTraceField(item.id)],
    ["Source", stringTraceField(inner.sourceMethod)],
    [
      "Command",
      stringTraceField(item.command) ||
        stringTraceField(action?.command) ||
        stringTraceField(details?.command) ||
        traceCommandActionLine(item.commandActions ?? details?.commandActions),
    ],
    ["CWD", stringTraceField(item.cwd) || stringTraceField(details?.cwd)],
    ["Exit code", traceNumberLine(item.exitCode ?? item.exit_code ?? details?.exitCode ?? details?.exit_code)],
    ["Success", traceBooleanLine(item.success ?? details?.success)],
    ["Message", stringTraceField(item.message) || stringTraceField(details?.message)],
    [
      "Path",
      stringTraceField(item.path) ||
        stringTraceField(item.filePath) ||
        stringTraceField(item.file_path) ||
        traceLocationPath(item.locations) ||
        traceLocationPath(details?.locations) ||
        stringTraceField(details?.path) ||
        stringTraceField(details?.savedPath),
    ],
  ]);
  const blocks = traceBlocks([
    [
      "Arguments",
      item.arguments ??
        item.args ??
        item.input ??
        item.rawInput ??
        details?.arguments ??
        details?.args ??
        details?.input ??
        details?.rawInput ??
        inner.arguments ??
        inner.input,
    ],
    [
      "Output",
      item.output ??
        item.result ??
        item.content ??
        item.aggregatedOutput ??
        item.stdout ??
        item.stderr ??
        item.delta ??
        item.rawOutput ??
        details?.output ??
        details?.result ??
        details?.content ??
        details?.aggregatedOutput ??
        details?.stdout ??
        details?.stderr ??
        details?.delta ??
        details?.rawOutput ??
        inner.output ??
        inner.result,
    ],
    ["Error", item.error ?? details?.error ?? inner.error],
    ["Patch", patch],
    ["Changes", patch ? null : item.changes ?? details?.changes],
    ["Metadata", traceToolMetadata(details, item)],
    ["Raw preview", inner.rawPreview],
  ]);

  return { body: renderStructuredTraceBody(fields, blocks), fields, blocks };
}

function traceToolItem(
  inner: Record<string, unknown>,
  details: Record<string, unknown> | null
): Record<string, unknown> {
  return (
    traceObjectValue(inner.update) ||
    traceObjectValue(inner.item) ||
    traceObjectValue(details?.item) ||
    traceObjectValue(details?.toolCall) ||
    traceObjectValue(details?.invocation) ||
    details ||
    inner
  );
}

function isPatchDeltaRuntimeTrace(inner: Record<string, unknown>): boolean {
  const method = stringTraceField(inner.runtimeMethod);
  const status = stringTraceField(inner.status);
  return status === "delta" && (method === "item/fileChange/patchUpdated" || method === "item/fileChange/outputDelta");
}

function traceCommandActionLine(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const commands = value
    .map((item) => {
      const record = traceObjectValue(item);
      return stringTraceField(record?.command) || stringTraceField(record?.cmd) || stringTraceField(record?.args);
    })
    .filter(Boolean);
  return commands.join(" ");
}

// ACP tool_call updates carry touched file locations as { path, line } entries
// (opencode uses these instead of a flat filePath).
function traceLocationPath(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const entry of value) {
    const record = traceObjectValue(entry);
    if (!record) continue;
    const path = stringTraceField(record.path) || stringTraceField(record.filePath) || stringTraceField(record.file_path);
    if (!path) continue;
    const line = traceNumberLine(record.line);
    return line ? `${path}:${line}` : path;
  }
  return "";
}

function traceToolMetadata(
  details: Record<string, unknown> | null,
  item: Record<string, unknown>
): Record<string, unknown> | null {
  const source = details || item;
  const metadata = Object.fromEntries(
    Object.entries(source).filter(([key]) => !TRACE_TOOL_SURFACED_KEYS.has(key))
  );
  return Object.keys(metadata).length ? metadata : null;
}

const TRACE_TOOL_SURFACED_KEYS = new Set([
  "id",
  "itemId",
  "type",
  "name",
  "toolName",
  "tool_name",
  "title",
  "kind",
  "sessionUpdate",
  "status",
  "call_id",
  "callId",
  "toolCallId",
  "tool_use_id",
  "call_name",
  "callName",
  "arguments",
  "args",
  "input",
  "rawInput",
  "action",
  "output",
  "result",
  "content",
  "rawOutput",
  "aggregatedOutput",
  "stdout",
  "stderr",
  "delta",
  "error",
  "patch",
  "diff",
  "changes",
  "command",
  "commandActions",
  "cwd",
  "exitCode",
  "exit_code",
  "success",
  "message",
  "path",
  "filePath",
  "file_path",
  "locations",
  "savedPath",
]);

function isRuntimeToolTrace(inner: Record<string, unknown>): boolean {
  const category = stringTraceField(inner.category);
  if (category === "tool") return true;
  if (stringTraceField(inner.toolName)) return true;
  const itemType = stringTraceField(inner.itemType).toLowerCase();
  return itemType === "function_call" || itemType === "tool_call" || itemType === "tool_result";
}

function traceToolName(item: Record<string, unknown>, inner: Record<string, unknown>): string {
  const direct =
    stringTraceField(item.name) ||
    stringTraceField(item.toolName) ||
    stringTraceField(item.tool_name) ||
    stringTraceField(item.tool) ||
    stringTraceField(item.title) ||
    stringTraceField(item.server_label) ||
    stringTraceField(item.serverLabel) ||
    stringTraceField(inner.name) ||
    stringTraceField(inner.toolName) ||
    stringTraceField(inner.tool_name) ||
    stringTraceField(inner.tool);
  if (direct) return direct;
  const action = traceObjectValue(item.action);
  return stringTraceField(action?.type) || stringTraceField(item.type) || stringTraceField(inner.type);
}

function tracePatchText(
  item: Record<string, unknown>,
  details: Record<string, unknown> | null
): string {
  const direct =
    stringTraceField(item.patch) ||
    stringTraceField(item.diff) ||
    stringTraceField(details?.patch) ||
    stringTraceField(details?.diff);
  if (direct) return direct;
  const changes = Array.isArray(item.changes)
    ? item.changes
    : Array.isArray(details?.changes)
      ? details?.changes
      : [];
  return changes
    .map((change) => {
      const record = traceObjectValue(change);
      return stringTraceField(record?.diff) || stringTraceField(record?.patch);
    })
    .filter(Boolean)
    .join("\n\n");
}

function traceObjectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function traceNumberLine(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : stringTraceField(value);
}

function traceBooleanLine(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "";
}

function traceFields(entries: Array<[string, string]>): AgentTraceTimelineField[] {
  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => ({ label, value }));
}

function traceBlocks(entries: Array<[string, unknown]>): AgentTraceTimelineBlock[] {
  return entries
    .map(([label, value]) => traceBlockValue(label, value))
    .filter((block): block is AgentTraceTimelineBlock => Boolean(block));
}

function traceBlockValue(label: string, value: unknown): AgentTraceTimelineBlock | null {
  const block = readableTraceBlock(value);
  if (!block.text) return null;
  const format = label === "Patch" ? "diff" : block.format;
  return {
    label,
    text: block.text,
    format,
    collapsed: format === "json" || block.text.length > 800,
  };
}

function renderStructuredTraceBody(fields: AgentTraceTimelineField[], blocks: AgentTraceTimelineBlock[]): string {
  return [
    ...fields.map((field) => `${field.label}: ${field.value}`),
    ...blocks.map((block) => `${block.label}:\n${block.text}`),
  ].join("\n");
}

function readableTraceBlock(value: unknown): { text: string; format: "text" | "json" } {
  if (typeof value === "string") {
    const parsed = parseTraceJson(value);
    if (parsed) return readableTraceBlock(parsed);
    return { text: compactTraceText(value), format: "text" };
  }
  if (value === undefined || value === null) return { text: "", format: "text" };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), format: "text" };
  try {
    return { text: compactTraceText(JSON.stringify(value, null, 2)), format: "json" };
  } catch {
    return { text: "", format: "text" };
  }
}

function tracePhaseTitle(record: TraceEventRecord): string {
  const phase = record.phase;
  if (phase === "runtime_event") return runtimeTraceTitle(record.inner);
  if (phase === "tool_call") return "Tool call";
  if (phase === "tool_call_started") return "Tool call started";
  if (phase === "tool_call_delta") return "Tool call update";
  if (phase === "tool_call_completed") return "Tool call completed";
  if (phase === "tool_result") return "Tool result";
  return humanizeTracePhase(phase);
}

function traceRecordKind(record: TraceEventRecord): AgentTraceTimelineItem["kind"] {
  if (record.phase === "turn_failed") return "error";
  if (record.phase === "turn_cancelled" || record.phase === "turn_completed") return "status";
  if (record.phase === "runtime_event") {
    const category = stringTraceField(record.inner?.category);
    const status = stringTraceField(record.inner?.status);
    if (category === "tool" || isRuntimeToolTrace(record.inner || {})) return "tool";
    if (category === "connection") return "status";
    if (category === "error" || status === "failed") return "error";
    return "runtime";
  }
  if (isToolTracePhase(record.phase)) return "tool";
  return "runtime";
}

function runtimeTraceTitle(inner: Record<string, unknown> | null): string {
  const category = stringTraceField(inner?.category);
  const status = stringTraceField(inner?.status);
  if (category === "tool") {
    if (status === "started") return "Tool call started";
    if (status === "delta") return "Tool call update";
    if (status === "completed") return "Tool call completed";
    if (status === "failed") return "Tool call failed";
    return "Tool call";
  }
  if (category === "turn") {
    if (status === "completed") return "Runtime completed";
    if (status === "started") return "Runtime started";
  }
  if (category === "reasoning") return "Reasoning";
  if (category === "plan") return "Plan";
  if (category === "connection") return status === "retrying" ? "Connection reconnecting" : "Connection event";
  if (category === "error" || status === "failed") return "Runtime error";
  return "Runtime event";
}

function traceDeltaValue(inner: Record<string, unknown> | null): unknown {
  return inner?.delta ?? inner?.text ?? inner?.content ?? inner?.message ?? inner;
}

function traceDeltaSegmentKey(record: TraceEventRecord): string {
  const messageId = stringTraceField(record.inner?.messageId) || stringTraceField(record.inner?.message_id);
  if (!messageId) return "";
  return [stringTraceField(record.payload?.source), messageId].filter(Boolean).join(":");
}

function traceRuntimeDeltaValue(inner: Record<string, unknown> | null): unknown {
  const details = traceObjectValue(inner?.details);
  return (
    inner?.delta ??
    details?.delta ??
    details?.output ??
    details?.result ??
    details?.message ??
    inner?.output ??
    inner?.result ??
    inner?.message
  );
}

function traceRuntimeDeltaSegmentKey(record: TraceEventRecord): string {
  const inner = record.inner || {};
  const details = traceObjectValue(inner.details);
  return [
    stringTraceField(inner.runtimeMethod),
    stringTraceField(inner.itemId) || stringTraceField(details?.itemId),
    stringTraceField(inner.itemType) || stringTraceField(inner.category),
  ]
    .filter(Boolean)
    .join(":");
}

function traceContentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readableTraceText(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseTraceJson(value);
    if (parsed) return readableTraceText(parsed);
    return compactTraceText(value);
  }
  if (Array.isArray(value)) {
    return value.map(readableTraceText).filter(Boolean).join("\n\n");
  }
  const record = traceContentRecord(value);
  if (!record) return "";
  const nested = traceInnerPayload(record);
  if (nested) return readableTraceText(nested);

  const text =
    record.text ||
    record.delta ||
    record.input ||
    record.value ||
    record.message ||
    record.prompt ||
    record.error ||
    record.content;
  if (typeof text === "string") return readableTraceText(text);

  const userMessage = record.userMessage || record.user_message || record.body;
  if (typeof userMessage === "string") return readableTraceText(userMessage);

  return "";
}

function readableTraceDelta(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseTraceJson(value);
    if (parsed) return readableTraceDelta(parsed);
    return value;
  }
  const record = traceContentRecord(value);
  if (!record) return "";
  const nested = traceInnerPayload(record);
  if (nested) return readableTraceDelta(nested);

  const text = record.delta || record.text || record.content || record.message;
  return typeof text === "string" ? readableTraceDelta(text) : "";
}

function appendTraceDelta(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  return `${current}${next}`;
}

function normalizeTraceStreamText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTraceJson(value: string): unknown | null {
  const text = value.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function compactTraceText(value: string): string {
  const text = value.trim();
  if (text.length <= 2000) return text;
  return `${text.slice(0, 2000).trimEnd()}...`;
}

function isTraceDeltaPhase(phase: string): boolean {
  return phase === "assistant_delta" || phase === "output_delta";
}

function isToolTracePhase(phase: string): boolean {
  return phase === "tool_call" ||
    phase === "tool_call_started" ||
    phase === "tool_call_delta" ||
    phase === "tool_call_update" ||
    phase === "tool_call_completed" ||
    phase === "tool_result";
}

function humanizeTracePhase(phase: string): string {
  const words = phase
    .split(/[_\s-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return "Event";
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

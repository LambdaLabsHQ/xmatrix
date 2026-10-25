import { ChannelPresenceConflict, decodeChannelSnapshot, encodeChannelSnapshot, emptyChannelPresence, presenceInstanceId, reduceChannelPresence, withRegistrationQuota, type AgentInstancePresence, type ChannelSnapshot } from "@xmatrix/protocol";
import type {
  LlmUsage,
  SerializedAgent,
  SerializedAgentInstance,
  SerializedChannel,
} from "@xmatrix/protocol";
import type { HumanServerMessage } from "@xmatrix/protocol/connections/human";
import type { AgentInstanceRuntimeSession } from "./agent-instance-port";
import {
  agentSummaryPresentation,
  sanitizeAgentInstancePresentation,
  type AgentInstancePresentation,
} from "./agent-instance-presentation";

export interface AgentInstanceLivePresenceSession {
  principal: Pick<
    AgentInstanceRuntimeSession["principal"],
    "ownerUserId" | "agentId" | "agentName" | "runId" | "channelId"
  >;
  run: Pick<
    AgentInstanceRuntimeSession["run"],
    | "runId"
    | "agentId"
    | "instanceId"
    | "channelId"
    | "channelInstanceId"
    | "machineId"
    | "hostId"
    | "cwd"
    | "repository"
    | "status"
    | "instanceStatus"
  >;
  connectedAt: string;
  lastSeenAt: string;
  presentation?: AgentInstancePresentation;
}

export function overlayAgentPresenceOnChannel(
  channel: SerializedChannel,
  input: {
    reason: "connect" | "update" | "disconnect";
    session: Readonly<AgentInstanceLivePresenceSession>;
    status?: SerializedAgentInstance["status"];
    offlineReason?: SerializedAgentInstance["offlineReason"];

  },
): SerializedChannel {
  return encodeChannelSnapshot(overlayAgentPresenceSnapshot(decodeChannelSnapshot(channel), input));
}

export function overlayAgentPresenceSnapshot(channel: ChannelSnapshot,
  input: { reason: "connect" | "update" | "disconnect"; session: Readonly<AgentInstanceLivePresenceSession>;
    status?: SerializedAgentInstance["status"]; offlineReason?: SerializedAgentInstance["offlineReason"] }): ChannelSnapshot {
  try { return overlayBoundInstance(channel, input); }
  catch (error) {
    if (!(error instanceof ChannelPresenceConflict) && !(error instanceof TypeError)) throw error;
    console.error("[presence] rejected_live_session", channel.id, input.session.run.instanceId);
    return channel;
  }
}

function overlayBoundInstance(channel: ChannelSnapshot,
  input: { reason: "connect" | "update" | "disconnect"; session: Readonly<AgentInstanceLivePresenceSession>;
    status?: SerializedAgentInstance["status"]; offlineReason?: SerializedAgentInstance["offlineReason"] }): ChannelSnapshot {
  const { reason, session } = input;
  const id = presenceInstanceId(session.run.instanceId);
  let presence = channel.presence ?? emptyChannelPresence(channel.id);
  if (reason === "disconnect") {
    presence = reduceChannelPresence(presence, { type: "remove", instanceId: id });
    return { ...channel, presence };
  }
  const existing = presence.instances.get(id);
  if (!existing) {
    console.warn("[presence] unbound_live_instance", channel.id, id);
    return channel;
  }
  const channelInstanceId = session.run.channelInstanceId || existing.channelInstanceId;
  if (!channelInstanceId) throw new ChannelPresenceConflict(channel.id);
  const now = new Date().toISOString();
  const reported = sanitizeAgentInstancePresentation(session.presentation) || {};
  const status = input.status || session.run.instanceStatus || "online";
  const next: AgentInstancePresence = {
    ...existing, ...reported, id, channelId: channel.id, channelInstanceId,
    agentName: existing?.agentName || session.principal.agentName || "Agent",
    label: existing?.label || `${session.principal.agentName || "agent"}:${channelInstanceId}`,
    connectedAt: earliestIsoTimestamp(existing?.connectedAt, session.connectedAt, now),
    lastSeenAt: session.lastSeenAt || now, status, rest: undefined,
    offlineReason: status === "offline" ? input.offlineReason : undefined,
    usage: withRegistrationQuota(reported.usage, existing?.usage),
    ...(session.run.machineId ? { machineId: session.run.machineId } : {}),
    ...(session.run.hostId ? { hostId: session.run.hostId } : {}),
    ...(session.run.cwd ? { cwd: session.run.cwd } : {}),
    ...(session.run.repository ? { repository: session.run.repository } : {}),
  };
  presence = reduceChannelPresence(presence, { type: "upsert", source: "live", authoritative: true, instance: next });
  return { ...channel, presence };
}

function earliestIsoTimestamp(...values: Array<string | undefined>): string {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms >= earliestMs) continue;
    earliestMs = ms;
    earliest = value;
  }
  return earliest || values.find((value): value is string => Boolean(value)) || new Date().toISOString();
}

export function serializeAgentFromSession(
  session: Readonly<AgentInstanceRuntimeSession>,
  presentation: Readonly<AgentInstancePresentation> | undefined = session.presentation,
  status: SerializedAgentInstance["status"] = session.run.instanceStatus,
  offlineReason?: SerializedAgentInstance["offlineReason"],
): SerializedAgent {
  return serializeAgentFromLivePresence(session, {
    presentation,
    status,
    ...(offlineReason ? { offlineReason } : {}),
    metadata: {
      runId: session.principal.runId,
      executionKey: session.principal.executionKey,
      ...(presentation?.workspace ? { workspace: presentation.workspace } : {}),
      ...(presentation?.workspaceName ? { workspaceName: presentation.workspaceName } : {}),
    },
  });
}

/**
 * The card people are shown for one live Instance: as it reports itself, with
 * the status it is shown in and its registration's quota reading.
 */
export function agentPresenceCard(
  session: Readonly<AgentInstanceLivePresenceSession>,
  input: {
    status?: SerializedAgentInstance["status"];
    offlineReason?: SerializedAgentInstance["offlineReason"];
    registrationQuota?: LlmUsage;
    executionKey?: string;
  } = {},
): Extract<HumanServerMessage, { type: "enhanced_presence" }> {
  const status = input.status ?? session.run.instanceStatus;
  // Carry the Agent's account windows, not just this Instance's last read, so
  // the Human UI patches every Channel showing the Agent with the same meters.
  const usage = withRegistrationQuota(session.presentation?.usage, input.registrationQuota);
  const { usage: _instanceUsage, ...presentation } = session.presentation ?? {};
  return {
    type: "enhanced_presence",
    agent: {
      ...serializeAgentFromLivePresence(session, {
        presentation: { ...presentation, ...(usage ? { usage } : {}) },
        status,
        ...(input.offlineReason ? { offlineReason: input.offlineReason } : {}),
        metadata: {
          runId: session.principal.runId,
          ...(input.executionKey ? { executionKey: input.executionKey } : {}),
          ...(presentation.workspace ? { workspace: presentation.workspace } : {}),
          ...(presentation.workspaceName ? { workspaceName: presentation.workspaceName } : {}),
        },
      }),
      status,
    },
  };
}

export function serializeAgentFromLivePresence(
  session: Readonly<AgentInstanceLivePresenceSession>,
  input: {
    presentation?: Readonly<AgentInstancePresentation>;
    status?: SerializedAgentInstance["status"];
    offlineReason?: SerializedAgentInstance["offlineReason"];
    metadata?: Record<string, unknown>;
  } = {},
): SerializedAgent {
  const presentation = sanitizeAgentInstancePresentation(input.presentation ?? session.presentation);
  const status = input.status ?? session.run.instanceStatus;
  const offline = status === "offline" && input.offlineReason
    ? { offlineReason: input.offlineReason }
    : {};
  const channelInstanceId = session.run.channelInstanceId || "1";
  return {
    id: session.principal.agentId,
    instanceId: session.run.instanceId,
    channelInstanceId,
    userId: session.principal.ownerUserId,
    name: session.principal.agentName,
    type: "agent",
    lifetime: "short",
    email: "",
    metadata: input.metadata ?? { runId: session.principal.runId },
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
    status,
    ...offline,
    ...agentSummaryPresentation(presentation),
    instances: [{
      ...presentation,
      id: session.run.instanceId,
      channelInstanceId,
      channelId: session.run.channelId,
      label: `${session.principal.agentName || "agent"}:${channelInstanceId}`,
      status,
      ...offline,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      ...(session.run.machineId ? { machineId: session.run.machineId } : {}),
      ...(session.run.hostId ? { hostId: session.run.hostId } : {}),
      ...(session.run.cwd ? { cwd: session.run.cwd } : {}),
      ...(session.run.repository ? { repository: session.run.repository } : {}),
    }],
  };
}

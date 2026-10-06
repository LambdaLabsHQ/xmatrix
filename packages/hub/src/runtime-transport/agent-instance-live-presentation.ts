import { withRegistrationQuota, channelInstanceQuota } from "../registration-quota-presentation";
import type {
  ChannelAgentMemberPresence,
  SerializedAgent,
  SerializedAgentInstance,
  SerializedChannel,
} from "@xmatrix/protocol";
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
  const { reason, session } = input;
  const agentId = session.principal.agentId;
  const memberPresence = { ...channel.memberPresence };
  const current = memberPresence[agentId];
  const stablePresence: ChannelAgentMemberPresence = current?.kind === "agent"
    ? current
    : {
        kind: "agent",
        label: session.principal.agentName || agentId,
        instances: [],
      };
  let instances = [...(stablePresence.instances || [])];
  if (reason === "disconnect") {
    instances = instances.filter((instance) => instance.id !== session.run.instanceId);
  } else {
    const byId = instances.find((instance) => instance.id === session.run.instanceId);
    // Only reuse a channel slot when the session names it. Defaulting to "1"
    // would collapse unrelated multi-instance cards onto the first birth slot.
    const bySlot = session.run.channelInstanceId
      ? instances.find((instance) =>
        Boolean(instance.channelInstanceId)
        && instance.channelInstanceId === session.run.channelInstanceId
      )
      : undefined;
    const existing = byId || bySlot;
    const channelInstanceId = existing?.channelInstanceId
      || session.run.channelInstanceId
      || "1";
    const now = new Date().toISOString();
    const reported = sanitizeAgentInstancePresentation(session.presentation) || {};
    const presentation = { ...reported, usage: withRegistrationQuota(reported.usage, channelInstanceQuota(channel, session.run.instanceId) ?? stablePresence.usage) };
    const birthConnectedAt = earliestIsoTimestamp(
      existing?.connectedAt,
      session.connectedAt,
      now,
    );
    const status = input.status || session.run.instanceStatus || "online";
    const nextInstance: SerializedAgentInstance = {
      ...presentation,
      id: session.run.instanceId,
      channelInstanceId,
      channelId: session.run.channelId,
      label: existing?.label
        || `${session.principal.agentName || "agent"}:${channelInstanceId}`,
      connectedAt: birthConnectedAt,
      lastSeenAt: session.lastSeenAt || now,
      status,
      ...(status === "offline" && input.offlineReason ? { offlineReason: input.offlineReason } : {}),
      ...(session.run.machineId ? { machineId: session.run.machineId } : {}),
      ...(session.run.hostId ? { hostId: session.run.hostId } : {}),
      ...(session.run.cwd ? { cwd: session.run.cwd } : {}),
    };
    instances = [
      ...instances.filter((instance) => {
        if (instance.id === session.run.instanceId) return false;
        if (
          bySlot
          && instance.channelInstanceId
          && instance.channelInstanceId === session.run.channelInstanceId
        ) {
          return false;
        }
        return true;
      }),
      nextInstance,
    ].sort(compareAgentInstanceBirthOrder);
  }
  if (instances.length === 0) {
    delete memberPresence[agentId];
    return { ...channel, memberPresence };
  }
  const preferred = preferredAgentPresenceInstance(instances);
  const usage = preferred.usage;
  memberPresence[agentId] = {
    kind: "agent",
    ...(stablePresence.label ? { label: stablePresence.label } : {}),
    ...(stablePresence.registration ? { registration: stablePresence.registration } : {}),
    ...(stablePresence.email ? { email: stablePresence.email } : {}),
    ...(stablePresence.avatarUrl ? { avatarUrl: stablePresence.avatarUrl } : {}),
    lastSeenAt: preferred.lastSeenAt,
    ...(preferred.activity ? { activity: preferred.activity } : {}),
    ...(preferred.files ? { files: preferred.files } : {}),
    ...(preferred.intent ? { intent: preferred.intent } : {}),
    ...(preferred.runtimeState ? { runtimeState: preferred.runtimeState } : {}),
    ...(preferred.goal ? { goal: preferred.goal } : {}),
    ...(usage ? { usage } : {}),
    instances,
  };
  return { ...channel, memberPresence };
}

function preferredAgentPresenceInstance(
  instances: readonly SerializedAgentInstance[],
): SerializedAgentInstance {
  const rank = (status: SerializedAgentInstance["status"]) =>
    status === "busy" ? 0 : status === "online" ? 1 : status === "idle" ? 2 : 3;
  return [...instances].sort((left, right) => {
    const statusRank = rank(left.status) - rank(right.status);
    return statusRank || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
  })[0]!;
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

/** Stable Agents-panel order: earliest birth first, then channel slot, then id. */
function compareAgentInstanceBirthOrder(
  left: SerializedAgentInstance,
  right: SerializedAgentInstance,
): number {
  const leftTime = Date.parse(left.connectedAt || "");
  const rightTime = Date.parse(right.connectedAt || "");
  const hasLeft = Number.isFinite(leftTime);
  const hasRight = Number.isFinite(rightTime);
  if (hasLeft && hasRight && leftTime !== rightTime) return leftTime - rightTime;
  if (hasLeft !== hasRight) return hasLeft ? -1 : 1;
  const leftSlot = Number(left.channelInstanceId || 0);
  const rightSlot = Number(right.channelInstanceId || 0);
  if (leftSlot !== rightSlot) return leftSlot - rightSlot;
  return left.id.localeCompare(right.id);
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
    }],
  };
}

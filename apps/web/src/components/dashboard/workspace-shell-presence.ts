/**
 * Pure presence / trace-matching helpers (no workspace UI view module imports).
 */
import { agentTraceInstanceIds } from "@/components/dashboard/agent-trace-target";
import { traceEventChannelInstanceId } from "@/components/dashboard/agent-trace-replica";
import type { AgentTraceTarget } from "./workspace-shell-message-model";
import { isChannelResidentInstance, isLiveAgentStatus } from "@xmatrix/protocol";
import { formatRelativeAge } from "./time-display";
import type {
  ChannelMemberPresence,
  ChannelHumanMemberPresence,
  ObservabilityEvent,
  SerializedAgent,
  SerializedAgentInstance,
  SerializedChannel,
} from "@xmatrix/protocol";

export type PresentedChannelMemberPresence = ChannelMemberPresence |
  (Omit<ChannelHumanMemberPresence, "status"> & { status?: undefined });

export function isOnlinePresence(status: string | undefined): boolean {
  return isLiveAgentStatus(status);
}

/**
 * An Instance the Channel still shows: live, or resting until the next message
 * wakes it (docs/instance-sleep.md §5). The work dock and the Channel list
 * share this so neither drops a sleeping Instance the other keeps.
 */
export function isChannelResidentPresence(instance: Pick<SerializedAgentInstance, "status" | "rest">): boolean {
  return isChannelResidentInstance(instance);
}

export function isOlderThan(timestamp: string | undefined, maxAgeMs: number): boolean {
  const time = Date.parse(timestamp || "");
  if (!Number.isFinite(time)) return false;
  return Date.now() - time > maxAgeMs;
}

export function relativeTime(value: string): string {
  return formatRelativeAge(value) ?? value;
}

/** Display status of an Instance whose own socket is open but whose machine is not. */
export const MACHINE_OFFLINE_DISPLAY_STATUS = "machine offline";

export function isMachineOfflineInstance(
  instance: { status?: string; offlineReason?: string } | undefined,
): boolean {
  return instance?.status === "offline" && instance.offlineReason === "machine_offline";
}

export function presenceStatusLabel(presence: {
  status?: string;
  activity?: string;
  offlineReason?: string;
}): string {
  // A last reported activity is not happening: nothing reaches the machine.
  // (Inlined: source-extraction tests load this function on its own.)
  if (presence.status === "offline" && presence.offlineReason === "machine_offline") return "Machine offline";
  if (presence.activity) return presence.activity;
  if (presence.status === "busy") return "Busy";
  if (presence.status === "waiting") return "Waiting";
  if (presence.status === "wake_failed") return "Wake failed";
  return presence.status || "offline";
}

export function agentInstancePresenceLabel(
  presence: { status?: string; activity?: string; offlineReason?: string },
  usageLimit?: { severity: "limit" | "warning"; title: string },
): string {
  // The status column is one word wide; the full sentence is its hover title.
  if (usageLimit?.severity === "limit") return "Limit";
  return presenceStatusLabel(presence);
}

export function memberPresence(
  channel: SerializedChannel,
  member: string,
  agentsById?: Map<string, SerializedAgent>
): PresentedChannelMemberPresence {
  const presence = channel.memberPresence?.[member];
  if (presence) return presence;
  if (member.startsWith("user:") && channel.memberPresence === undefined) {
    return { kind: "user", activity: "Status unknown" };
  }
  const agent = agentsById?.get(member);
  if (agent) {
    return {
      kind: "agent",
      label: agent.name,
      email: agent.email,
      lastSeenAt: agent.lastSeenAt,
      instances: [],
    };
  }
  return (member.startsWith("user:")
      ? { kind: "user" as const, status: "offline" as const }
      : { kind: "agent" as const });
}

export function isDaemonChannelMember(channel: SerializedChannel, member: string): boolean {
  if (!member.startsWith("agent:")) return false;
  const presence = channel.memberPresence?.[member];
  const label = (presence?.label || member).trim().toLowerCase();
  return label === "xmatrix-daemon" || label.startsWith("xmatrix-daemon-");
}

export function channelMembersByPresence(channel: SerializedChannel): string[] {
  return Object.keys(channel.memberPresence || {}).filter(
    (member) => !isDaemonChannelMember(channel, member)
  );
}

export function isAgentTraceEvent(
  event: ObservabilityEvent,
  target: AgentTraceTarget,
  options: { ignoreInstanceScope?: boolean } = {}
): boolean {
  if (target.channelId && event.channelId && event.channelId !== target.channelId) return false;
  if (target.instanceScoped && !options.ignoreInstanceScope) {
    if (!target.instanceIds || target.instanceIds.length === 0) return false;
    const instanceId = traceEventChannelInstanceId(event);
    if (!instanceId || !target.instanceIds.includes(instanceId)) return false;
  }
  const targetName = target.name.trim().toLowerCase();
  if (target.id && (event.agentId === target.id || event.targetAgentId === target.id)) return true;
  if (event.agentName?.trim().toLowerCase() === targetName) return true;
  return false;
}

export function isLlmTraceEvent(event: ObservabilityEvent): boolean {
  return event.metadata?.eventType === "llm_trace";
}

export function isAgentLlmTraceEvent(
  event: ObservabilityEvent,
  target: AgentTraceTarget,
  options: { ignoreInstanceScope?: boolean } = {}
): boolean {
  if (event.metadata?.eventType !== "llm_trace") return false;
  if (!isAgentTraceEvent(event, target, options)) return false;
  return isLlmTraceEvent(event);
}

export function isAgentSpawnEvent(event: ObservabilityEvent, target: AgentTraceTarget): boolean {
  if (event.type !== "agent_spawn_started" && event.type !== "agent_spawn_finished") return false;
  return isAgentTraceEvent(event, target);
}

export function latestAgentWorkEvent(
  events: readonly ObservabilityEvent[],
  target: AgentTraceTarget,
  channelId?: string
): ObservabilityEvent | undefined {
  return events
    .filter(
      (event) =>
        (!channelId || !event.channelId || event.channelId === channelId) &&
        (isAgentLlmTraceEvent(event, target) || isAgentSpawnEvent(event, target))
    )
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
    )[0];
}

export function isTraceDeltaPhase(phase: string): boolean {
  return phase === "assistant_delta" || phase === "output_delta";
}

export function agentTraceEventPhase(
  event: ObservabilityEvent | undefined
): string {
  const payload = event?.metadata?.payload;
  if (!payload || typeof payload !== "object") return "";
  const phase = (payload as Record<string, unknown>).phase;
  return typeof phase === "string" ? phase : "";
}

export function agentInstanceDisplayStatus({
  agentId,
  channelId,
  events,
  instance,
  fallbackStatus,
  name,
  activity,
}: {
  agentId?: string;
  channelId?: string;
  events: readonly ObservabilityEvent[];
  instance?: SerializedAgentInstance;
  fallbackStatus?: string;
  name: string;
  activity?: string;
}): string {
  // A resting Instance has no live trace to read; its rest is its status.
  if (instance?.status === "offline" && instance.rest) return instance.rest;
  // Its trace may still read as working, but the machine running it is gone.
  if (isMachineOfflineInstance(instance)) return MACHINE_OFFLINE_DISPLAY_STATUS;
  // Work in hand that its runtime says waits on something outside the model
  // (docs/design/agent-status.md). Only the runtime knows; a trace never says.
  if (instance && isLiveAgentStatus(instance.status) && instance.runtimeState?.waiting) return "waiting";
  if (instance && isLiveAgentStatus(instance.status) && instance.runtimeState?.issue?.kind === "retrying") return "waiting";
  if (instance?.status === "busy" || fallbackStatus === "busy") return "busy";
  if (!instance || !agentId) return fallbackStatus || instance?.status || "offline";

  const target: AgentTraceTarget = {
    id: agentId,
    instanceId: instance.id,
    instanceIds: agentTraceInstanceIds(instance),
    exactInstanceIds: [instance.id],
    instanceScoped: true,
    connectedAt: instance.connectedAt,
    name,
    status: instance.status,
    activity: activity || presenceStatusLabel(instance),
  };
  const latestEvent = latestAgentWorkEvent(events, target, channelId);
  const phase = agentTraceEventPhase(latestEvent);
  if (phase === "turn_started" || isTraceDeltaPhase(phase)) return "busy";
  return instance.status || fallbackStatus || "offline";
}

/**
 * Each Channel's view of the realtime events: those naming it, then those
 * naming no Channel, which every Channel's presence may read. A Channel whose
 * view holds the same events as in `previous` keeps that same array, so a
 * conversation row re-renders when its own Channel's events change, not on
 * every event anywhere in the Space.
 */
export function channelEventViews(
  events: readonly ObservabilityEvent[],
  channelIds: readonly string[],
  previous: ReadonlyMap<string, readonly ObservabilityEvent[]>,
): Map<string, readonly ObservabilityEvent[]> {
  const wanted = new Set(channelIds);
  const own = new Map<string, ObservabilityEvent[]>();
  const unscoped: ObservabilityEvent[] = [];
  for (const event of events) {
    if (!event.channelId) unscoped.push(event);
    else if (wanted.has(event.channelId)) {
      const list = own.get(event.channelId);
      if (list) list.push(event);
      else own.set(event.channelId, [event]);
    }
  }
  const views = new Map<string, readonly ObservabilityEvent[]>();
  for (const channelId of wanted) {
    const ownEvents = own.get(channelId);
    const view = ownEvents ? (unscoped.length ? ownEvents.concat(unscoped) : ownEvents) : unscoped;
    const before = previous.get(channelId);
    views.set(channelId, before && sameEvents(before, view) ? before : view);
  }
  return views;
}

function sameEvents(left: readonly ObservabilityEvent[], right: readonly ObservabilityEvent[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

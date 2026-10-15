import type { AgentRuntimeIssue, AgentRuntimeNotice, AgentRuntimeWaiting, SerializedChannel } from "@xmatrix/protocol";
import { agentInstanceBranchLabel, type AgentWorkItem } from "./workspace-shell-message-model";
import { agentInstanceDisplayStatus, presenceStatusLabel } from "./workspace-shell-presence";
import type { UsageLimitSummary } from "./workspace-shell-domain-types";
import { shareByKey } from "../../lib/same-value";

/** Display data only. Actions must resolve the full current item by key. */
export type AgentWorkView = Readonly<{
  key: string;
  agentId: string;
  instanceId: string;
  label: string;
  instanceLabel?: string;
  agentLabel: string;
  avatarKind: "agent" | "system";
  avatarUrl?: string;
  displayStatus: string;
  intent?: string;
  waiting?: AgentRuntimeWaiting;
  issue?: AgentRuntimeIssue;
  notice?: AgentRuntimeNotice;
  usageLimit?: Pick<UsageLimitSummary, "label" | "severity" | "title">;
  branchLabel: string;
  statusLabel?: string;
  wakeFailureReason?: string;
  canStop: boolean;
  canReborn: boolean;
}>;

export function agentWorkDisplayStatus(item: AgentWorkItem): string {
  return agentInstanceDisplayStatus({
    agentId: item.agentId,
    events: item.latestEvent ? [item.latestEvent] : [],
    instance: item.instance,
    fallbackStatus: item.status,
    name: item.agentLabel,
    activity: item.activity,
  });
}

export function agentWorkCanReborn(item: AgentWorkItem): boolean {
  if (item.canStop === false || item.avatarKind === "system") return false;
  const channelInstanceId = item.instance.channelInstanceId?.trim();
  return Boolean(channelInstanceId && /^[1-9]\d*$/.test(channelInstanceId));
}

function project(item: AgentWorkItem): AgentWorkView {
  const displayStatus = agentWorkDisplayStatus(item);
  const waiting = displayStatus === "waiting" ? item.instance.runtimeState?.waiting : undefined;
  // Only what the dock shows: a view is kept while it says the same, so a
  // field nothing draws would redraw it each time the field moved.
  const limit = item.usageLimit;
  return {
    key: item.key, agentId: item.agentId, instanceId: item.instance.id,
    label: item.label, instanceLabel: item.instance.label, agentLabel: item.agentLabel,
    avatarKind: item.avatarKind || "agent", avatarUrl: item.avatarUrl,
    displayStatus, intent: item.intent, waiting,
    issue: item.instance.runtimeState?.issue, notice: item.instance.runtimeState?.notice,
    usageLimit: limit && { label: limit.label, severity: limit.severity, title: limit.title },
    branchLabel: agentInstanceBranchLabel(item.instance),
    statusLabel: waiting ? undefined : presenceStatusLabel({
      status: displayStatus, activity: displayStatus === "busy" ? undefined : item.activity,
    }),
    wakeFailureReason: item.instance.rest === "wake_failed" ? item.instance.restReason : undefined,
    canStop: item.canStop !== false, canReborn: agentWorkCanReborn(item),
  };
}

/** A cache of presentation, never an authority for live interactions. Derive
 * full work first so trace phases, quota resets and launch expiry still apply. */
export function createAgentWorkSelection(build: (channel: SerializedChannel | null) => AgentWorkItem[],
  initialViews: readonly AgentWorkView[] = []) {
  let source: SerializedChannel | null | undefined;
  let views = initialViews;
  return (channel: SerializedChannel | null): readonly AgentWorkView[] => {
    if (source === channel) return views;
    source = channel;
    views = shareByKey(views, build(channel).map(project), view => view.key);
    return views;
  };
}

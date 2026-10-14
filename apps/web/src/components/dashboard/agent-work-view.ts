import type { AgentRuntimeIssue, AgentRuntimeNotice, AgentRuntimeWaiting, SerializedChannel } from "@xmatrix/protocol";
import { agentInstanceBranchLabel, type AgentWorkItem } from "./workspace-shell-message-model";
import { agentInstanceDisplayStatus, presenceStatusLabel } from "./workspace-shell-presence";
import type { UsageLimitSummary } from "./workspace-shell-domain-types";

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
  return {
    key: item.key, agentId: item.agentId, instanceId: item.instance.id,
    label: item.label, instanceLabel: item.instance.label, agentLabel: item.agentLabel,
    avatarKind: item.avatarKind || "agent", avatarUrl: item.avatarUrl,
    displayStatus, intent: item.intent, waiting,
    issue: item.instance.runtimeState?.issue, notice: item.instance.runtimeState?.notice,
    usageLimit: item.usageLimit, branchLabel: agentInstanceBranchLabel(item.instance),
    statusLabel: waiting ? undefined : presenceStatusLabel({
      status: displayStatus, activity: displayStatus === "busy" ? undefined : item.activity,
    }),
    wakeFailureReason: item.instance.rest === "wake_failed" ? item.instance.restReason : undefined,
    canStop: item.canStop !== false, canReborn: agentWorkCanReborn(item),
  };
}

const scalarFields = ["key", "agentId", "instanceId", "label", "instanceLabel", "agentLabel", "avatarKind", "avatarUrl",
  "displayStatus", "intent", "branchLabel", "statusLabel", "wakeFailureReason", "canStop", "canReborn"] as const;

function sameView(left: AgentWorkView, right: AgentWorkView): boolean {
  const a = left.waiting;
  const b = right.waiting;
  return scalarFields.every(key => left[key] === right[key]) &&
    a?.kind === b?.kind && a?.label === b?.label && a?.sinceMillis === b?.sinceMillis &&
    (a?.details === b?.details || Boolean(a?.details && b?.details &&
      a.details.length === b.details.length && a.details.every((detail, index) => detail === b.details![index]))) &&
    left.issue?.kind === right.issue?.kind && left.issue?.sinceMillis === right.issue?.sinceMillis &&
    left.notice?.severity === right.notice?.severity && left.notice?.sinceMillis === right.notice?.sinceMillis &&
    left.usageLimit?.label === right.usageLimit?.label && left.usageLimit?.severity === right.usageLimit?.severity &&
    left.usageLimit?.title === right.usageLimit?.title;
}

/** A cache of presentation, never an authority for live interactions. Derive
 * full work first so trace phases, quota resets and launch expiry still apply. */
export function createAgentWorkSelection(build: (channel: SerializedChannel | null) => AgentWorkItem[],
  initialViews: readonly AgentWorkView[] = []) {
  let source: SerializedChannel | null | undefined;
  let views = initialViews;
  return (channel: SerializedChannel | null): readonly AgentWorkView[] => {
    if (source === channel) return views;
    const previous = new Map(views.map(item => [item.key, item]));
    const next = build(channel).map(item => {
      const view = project(item);
      const before = previous.get(view.key);
      return before && sameView(before, view) ? before : view;
    });
    source = channel;
    if (views.length !== next.length || next.some((item, index) => views[index] !== item)) views = next;
    return views;
  };
}

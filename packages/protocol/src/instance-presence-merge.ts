import type { SerializedAgentInstance } from "./authority-foundation.js";
import { sameValue } from "./same-value.js";
import { mergeLlmUsagePreferringQuotas } from "./presence-usage.js";

export function instanceLifecycleReportApplies(
  current: SerializedAgentInstance,
  update: SerializedAgentInstance
): boolean {
  if (update.status === "offline" && !update.rest) return true;
  return (Date.parse(update.lastSeenAt) || 0) >= (Date.parse(current.lastSeenAt) || 0);
}

export function mergeAgentInstancePresence<T extends SerializedAgentInstance>(
  current: T,
  update: T
): T {
  // Catalog pages, resolve reads, realtime frames, messages and cached
  // snapshots replayed from the query cache all arrive here, often behind
  // newer state. One rule orders them all.
  if (current.id !== update.id) throw new Error("Cannot merge different Instance identities");
  if (!instanceLifecycleReportApplies(current, update)) return current;
  const connectedAt = Date.parse(current.connectedAt) <= Date.parse(update.connectedAt) ? current.connectedAt : update.connectedAt;
  const merged: T = {
    ...current,
    ...update,
    // The lifecycle is one fact: whether the Instance is live, resting or
    // offline, and why. It is taken whole from the report that won above and
    // never assembled field by field, so no report's rest can outlive the
    // status it came with (a wake must not keep the sleep's moon).
    status: update.status,
    rest: update.rest,
    offlineReason: update.offlineReason,
    // Presence updates are patches. Runtime heartbeats deliberately omit the
    // slower-changing presentation fields, so an omitted field must retain
    // its last reported value instead of erasing every visible tag.
    model: update.model ?? current.model,
    models: update.models ?? current.models,
    effort: update.effort ?? current.effort,
    commands: update.commands ?? current.commands,
    statusChips: update.statusChips ?? current.statusChips,
    gitBranch: update.gitBranch ?? current.gitBranch,
    channelInstanceId: update.channelInstanceId || current.channelInstanceId,
    label: update.label || current.label,
    // Keep the original birth clock so Agents detail order does not jump when
    // a live presence frame carries a newer socket connectedAt.
    connectedAt,
    lastSeenAt: Date.parse(current.lastSeenAt) >= Date.parse(update.lastSeenAt) ? current.lastSeenAt : update.lastSeenAt,
    activity: update.activity ?? (update.status === current.status ? current.activity : undefined),
    files: update.files || current.files,
    intent: update.intent || current.intent,
    runtimeState: update.runtimeState ?? (update.status === "busy" ? current.runtimeState : undefined),
    goal: update.goal || current.goal,
    // Never let a token-only usage patch wipe subscription quota meters.
    usage: mergeLlmUsagePreferringQuotas(current.usage, update.usage),
  };
  // A frame that restates what we already hold must hand back the object we
  // already hold. The Channel tree re-renders on Channel identity, so a new
  // instance object for an unchanged report moves the sidebar and the
  // timeline under the reader for no reported reason.
  return sameValue(current, merged) ? current : merged;
}

import { existingInstanceMentionScanner, isLiveAgentStatus, type AgentInstancePresence } from "@xmatrix/protocol";
import type { TimelineItem } from "./workspace-shell-message-model";

/** An Instance a message is addressed to that is still on an earlier turn. */
export type QueuedBehindTurn = { address: string; since: string };

/** How many of the newest messages are checked: a queue is only ever recent. */
const RECENT_MESSAGES = 30;

/**
 * Messages a person sent to an Agent Instance that is still working on an
 * earlier turn. The Instance takes a message only when that turn ends, so
 * until then the message would sit without any sign: this says who it waits
 * on and since when. An Instance's message is addressed by `@name:n` or by
 * replying to it; what it is working on is its own report (runtimeState).
 */
export function queuedBehindTurns(timeline: readonly TimelineItem[],
  instances: readonly AgentInstancePresence[]): Map<string, readonly QueuedBehindTurn[]> {
  const queued = new Map<string, readonly QueuedBehindTurn[]>();
  const working = instances.filter(instance => isLiveAgentStatus(instance.status) &&
    instance.runtimeState?.status === "running" && instance.runtimeState.execution);
  if (!working.length) return queued;
  const byId = new Map(timeline.map(item => [item.messageId, item]));
  for (const item of timeline.slice(-RECENT_MESSAGES)) {
    if (!item.own || !item.messageId || item.senderKind === "agent") continue;
    const sentAt = Date.parse(item.sentAt);
    const addressed = new Set([...item.body.matchAll(existingInstanceMentionScanner())]
      .map(match => match[1]!.toLowerCase()));
    const repliedTo = item.replyToMessageId ? byId.get(item.replyToMessageId) : undefined;
    const entries = working.flatMap(instance => {
      const address = `${instance.agentName}:${instance.channelInstanceId ?? ""}`;
      const execution = instance.runtimeState!.execution!;
      const targeted = addressed.has(address.toLowerCase()) ||
        (repliedTo?.senderKind === "agent" && repliedTo.senderId === instance.id);
      // Taken already, or a turn that began after it: nothing is waiting.
      if (!targeted || !(execution.startedAtMillis < sentAt) ||
          execution.sources.some(source => source.messageId === item.messageId)) return [];
      return [{ address: `@${address}`, since: new Date(execution.startedAtMillis).toISOString() }];
    });
    if (entries.length) queued.set(item.messageId, entries);
  }
  return queued;
}

import type { AgentRuntimeState } from "@xmatrix/protocol";

/**
 * What the Channel is told when an Agent's turn stops making progress. The
 * host reports the fact (a turn it is running made no progress since a time:
 * `issue.kind === "stalled"`); the Hub decides it is worth saying, once per
 * stall, and says it under the message the turn is answering, so nobody waits
 * on a blank reply.
 */
export function stalledTurnNotice(input: {
  previous?: AgentRuntimeState;
  next?: AgentRuntimeState;
  channelId: string;
  instanceId: string;
  address: string;
  now: number;
}): { key: string; body: string; replyToMessageId: string } | undefined {
  const issue = input.next?.issue;
  if (issue?.kind !== "stalled" || input.next?.status !== "running") return undefined;
  const previous = input.previous?.issue;
  if (previous?.kind === "stalled" && previous.sinceMillis === issue.sinceMillis) return undefined;
  const replyToMessageId = input.next.activeMessageId;
  if (!replyToMessageId) return undefined;
  if (input.next.activeChannelId && input.next.activeChannelId !== input.channelId) return undefined;
  const minutes = Math.max(1, Math.round((input.now - issue.sinceMillis) / 60_000));
  return {
    key: `${input.instanceId}:${replyToMessageId}:${issue.sinceMillis}`,
    replyToMessageId,
    body: `${input.address} has shown no progress on this for ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
      `It may be stuck: wait for it, stop it with ${input.address}:stop, or ask another Agent.`,
  };
}

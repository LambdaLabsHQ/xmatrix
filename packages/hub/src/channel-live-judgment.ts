import { SYSTEM_ANNOTATION_AUTHOR, type ObservabilityEvent } from "@xmatrix/protocol";
import { postgresMessageLiveAgentPresence, postgresMessageLiveRecipientUserIds,
  withPostgresMessageRequestScope } from "./postgres-message-authority";
import {
  deliverToAudience,
  RUNTIME_CHANNEL_OBSERVABLE_EVENT_URL,
  runtimeJsonRequest,
} from "./runtime-transport/runtime-principal-delivery";
import type { Env } from "./types";

/* The Hub's judgments about a Channel's messages, pushed to its live people.
   Kept apart from channel-messages so launch, lifecycle and coordinator code
   can push without loading the whole message surface. */

/**
 * Tell a Channel's people what a message's command came to, as the Hub just
 * recorded it on that message. Clients apply the one annotation to the result
 * they hold; a dropped frame is repaired by the next history read, which
 * carries `commandResult`.
 */
export async function publishChannelMessageCommandResult(
  env: Env,
  input: { channelId: string; messageId: string; annotationId: string; payload: Record<string, unknown> },
): Promise<void> {
  await publishChannelMessageJudgment(env, input.channelId, "channel_message_interactions_updated",
    { messageId: input.messageId, annotationId: input.annotationId, payload: input.payload });
}

/**
 * Tell a Channel's people that the state of something its messages asked for
 * changed: a summon's launch, a stop, a reborn or handoff, a message's
 * execution, a first message's launch choice. Clients re-read those records
 * for the messages they show; nothing polls. Best effort: a write that already
 * committed is not undone because its push failed, and the next read repairs it.
 */
export async function publishChannelInvocationsChanged(env: Env, channelId: string): Promise<void> {
  await publishChannelMessageJudgment(env, channelId, "channel_invocations_changed", {})
    .catch((error: unknown) => console.warn("Channel invocation push failed", {
      channelId, error: error instanceof Error ? error.message : String(error) }));
}

/**
 * Tell a Channel's people how its Agents stand after one of its Instances
 * changed outside a live socket: it went to rest, a message woke it, its wake
 * waits for an offline machine, or it was stopped. The push carries the
 * Channel's Agents as its lists show them (`presenceCoverage: "agents"`), so a
 * client merges them in place and reads nothing; the people stay as it holds
 * them. It is the whole current state, not a step: a dropped push is repaired
 * by the next one or by the read a reconnect makes. Best effort, like the
 * pushes above.
 */
export async function publishChannelPresenceChanged(env: Env, channelId: string): Promise<void> {
  try {
    const { recipientUserIds, memberPresence } = await withPostgresMessageRequestScope(
      env, (scope) => postgresMessageLiveAgentPresence(env, channelId, scope));
    await publishToChannelPeople(env, channelId, recipientUserIds, "presence_updated",
      { memberPresence, presenceCoverage: "agents" });
  } catch (error) {
    console.warn("Channel presence push failed", {
      channelId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** A Hub judgment about one message, to every live member of its Channel. */
async function publishChannelMessageJudgment(
  env: Env,
  channelId: string,
  type: ObservabilityEvent["type"],
  metadata: Record<string, unknown>,
): Promise<void> {
  const recipientUserIds = await withPostgresMessageRequestScope(
    env,
    (scope) => postgresMessageLiveRecipientUserIds(env, channelId, scope),
  );
  await publishToChannelPeople(env, channelId, recipientUserIds, type, metadata);
}

async function publishToChannelPeople(
  env: Env,
  channelId: string,
  recipientUserIds: readonly string[],
  type: ObservabilityEvent["type"],
  metadata: Record<string, unknown>,
): Promise<void> {
  const event: ObservabilityEvent = {
    id: crypto.randomUUID(),
    type,
    workspaceUserId: SYSTEM_ANNOTATION_AUTHOR,
    channelId,
    metadata,
    timestamp: new Date().toISOString(),
  };
  await deliverToAudience({
    env, label: "Channel observable", audience: { humans: recipientUserIds },
    request: (share) => runtimeJsonRequest(RUNTIME_CHANNEL_OBSERVABLE_EVENT_URL,
      { recipientUserIds: [share.owner], event }),
  });
}


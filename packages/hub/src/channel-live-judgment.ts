import { SYSTEM_ANNOTATION_AUTHOR, type ObservabilityEvent } from "@xmatrix/protocol";
import { postgresMessageLiveRecipientUserIds, withPostgresMessageRequestScope } from "./postgres-message-authority";
import { publishRuntimeChannelObservableEvent } from "./runtime-transport/runtime-route-directory-delivery";
import type { Env } from "./types";

/* The Hub's judgments about a Channel's messages, pushed to its live people.
   Kept apart from channel-messages so launch, lifecycle and coordinator code
   can push without loading the whole message surface. */

const MAX_RUNTIME_RECIPIENTS_PER_DELIVERY = 1_000;

/** Live recipients in the batches one Runtime delivery takes. */
export function recipientBatches(userIds: string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < userIds.length; offset += MAX_RUNTIME_RECIPIENTS_PER_DELIVERY) {
    batches.push(userIds.slice(offset, offset + MAX_RUNTIME_RECIPIENTS_PER_DELIVERY));
  }
  return batches;
}

/**
 * Tell a Channel's people that the Hub folded one message under a later one
 * (docs/design/conversation-activity.md §3.3). The judgment lands seconds
 * after the later message, so every client holding the Channel's rows,
 * opened or not, applies it as it comes instead of finding out when the
 * Channel is next read. Only the two ids travel; a dropped frame is repaired
 * by the next history read, which carries `supersededBy`.
 */
export async function publishChannelMessageSuperseded(
  env: Env,
  input: { channelId: string; messageId: string; supersededBy: string },
): Promise<void> {
  await publishChannelMessageJudgment(env, input.channelId, "channel_message_superseded",
    { messageId: input.messageId, supersededBy: input.supersededBy });
}

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
  const event: ObservabilityEvent = {
    id: crypto.randomUUID(),
    type,
    workspaceUserId: SYSTEM_ANNOTATION_AUTHOR,
    channelId,
    metadata,
    timestamp: new Date().toISOString(),
  };
  const tasks: Promise<unknown>[] = [];
  const responses = await Promise.all(recipientBatches(recipientUserIds).map((recipients) =>
    publishRuntimeChannelObservableEvent({
      env,
      waitUntil: (task) => tasks.push(task),
      channelId,
      payload: { recipientUserIds: recipients, event: event as unknown as Record<string, unknown> },
    })));
  await Promise.allSettled(tasks);
  if (responses.some((response) => !response.ok)) {
    throw new Error(`Runtime rejected PostgreSQL ${type} delivery`);
  }
}


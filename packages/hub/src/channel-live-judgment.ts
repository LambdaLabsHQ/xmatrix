import { SYSTEM_ANNOTATION_AUTHOR, type ObservabilityEvent } from "@xmatrix/protocol";
import { postgresMessageLiveAgentPresence, postgresMessageLiveRecipientUserIds,
  withPostgresMessageRequestScope } from "./postgres-message-authority";
import {
  deliverToAudience,
  RUNTIME_CHANNEL_AGENT_PRESENCE_URL,
  RUNTIME_CHANNEL_OBSERVABLE_EVENT_URL,
  runtimeJsonRequest,
} from "./runtime-transport/runtime-principal-delivery";
import { channelAgentPresenceDeliveryBody, channelInstanceRecordBatches } from "./runtime-transport/channel-agent-presence-delivery";
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
 * Tell a Channel's people how its Agents stand after some of its Instances
 * (`instanceIds`) changed outside a live socket: they went to rest, a message
 * woke them, their wake waits for an offline machine, or they were stopped.
 * Each changed Instance is read exactly, so one that ended arrives as its
 * terminal record, never as an absence; the Channel's window comes with it.
 * Records go first; old clients get the Channel's Agents as their lists show
 * them (`presenceCoverage: "agents"`). A push that fails is read and sent
 * once more, so the last word on an Instance is the current one; past that,
 * the read a reconnect makes repairs it.
 */
export async function publishChannelPresenceChanged(env: Env, channelId: string,
  instanceIds: readonly string[] = []): Promise<void> {
  const publish = async () => {
    const { recipientUserIds, memberPresence, instanceRecords } = await withPostgresMessageRequestScope(
      env, (scope) => postgresMessageLiveAgentPresence(env, channelId, scope, instanceIds));
    for (const records of channelInstanceRecordBatches(instanceRecords)) {
      await deliverToAudience({
        env, label: "Instance records", audience: { humans: recipientUserIds },
        request: share => {
          const body = channelAgentPresenceDeliveryBody({ channelId, reason: "update", records,
            recipients: [{ userId: share.owner, digest: false, card: false, channel: false, immediate: [] }] });
          if (!body) throw new RangeError("Instance records exceed delivery budget");
          return runtimeJsonRequest(RUNTIME_CHANNEL_AGENT_PRESENCE_URL, body);
        },
      });
    }
    await publishToChannelPeople(env, channelId, recipientUserIds, "presence_updated",
      { memberPresence, presenceCoverage: "agents" });
  };
  try {
    await publish();
  } catch (first) {
    console.warn("Channel presence push failed; reading again", {
      channelId, error: first instanceof Error ? first.message : String(first) });
    await new Promise((resolve) => setTimeout(resolve, CHANNEL_PRESENCE_RETRY_MS));
    await publish().catch((error: unknown) => console.warn("Channel presence push failed", {
      channelId, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** How long a failed presence push waits before it reads and sends again. */
const CHANNEL_PRESENCE_RETRY_MS = 1_000;

/** The Instance a Run belongs to: stored Run ids are `<instanceId>#<n>` (0084). */
export function runInstanceId(runId: string): string | undefined {
  const at = runId.lastIndexOf("#");
  return at > 0 ? runId.slice(0, at) : undefined;
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


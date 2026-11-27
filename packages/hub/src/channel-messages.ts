import { MessageAuthorityError, type MessageLiveRouting } from "@xmatrix/db";
import type { CommandResultInterrupt } from "@xmatrix/protocol";
import { armAppResultRetention } from "./connectors/result-retention";
import { recordCommandResult } from "./command-result";
import type { AuthorityPrincipal } from "./product-message-command";
import type { Env } from "./types";
import { postBillingNotice } from "./billing-notice";
import { channelCatalogAttention } from "./spaces";
import {
  deliverToAudience,
  RUNTIME_CHANNEL_MESSAGE_URL,
  RUNTIME_CHANNEL_OBSERVABLE_EVENT_URL,
  runtimeJsonRequest,
  type RuntimeAudience,
  type RuntimeLiveDeliverySelf,
} from "./runtime-transport/runtime-principal-delivery";
import {
  channelAttentionUpdatedEvent,
  channelMemberReadEvent,
} from "./product-channel-read-fanout";
import { sealMessageAttachments } from "./postgres-content-authority";
import { messagePushNotifications, pageTitles, pushConfig, pushDevices, pushToPeople } from "./push/notify";
import {
  postgresMessageAcknowledge,
  postgresMessageAnnotations,
  postgresMessageAppend,
  postgresMessageErrorResponse,
  postgresMessageHistory,
  postgresMessageLiveAudience,
  postgresMessageLiveDeliveryRouting,
  postgresMessageLiveRecipientUserIds,
  postgresMessageMutation,
  postgresMessageRepairSenderSnapshots,
  postgresMessageRoute,
  postgresQuestionnaireState,
  postgresSettleQuestionnaire,
  withPostgresMessageRequestScope,
} from "./postgres-message-authority";


/** A message call's answer, or the Response its failure maps to. */
export type ChannelMessageResult = { ok: true; payload: Record<string, unknown> } | { ok: false; response: Response };

/** Run a message call, answering its failure the way message routes always have. */
export async function channelMessageResult(
  work: () => Promise<Record<string, unknown>>,
): Promise<ChannelMessageResult> {
  try {
    return { ok: true, payload: await work() };
  } catch (error) {
    return { ok: false, response: postgresMessageErrorResponse(error) };
  }
}

/** Answer a message call as JSON, or as the Response its failure maps to. */
export async function channelMessageResponse(
  work: () => Promise<Record<string, unknown>>,
  status = 200,
): Promise<Response> {
  const result = await channelMessageResult(work);
  return result.ok
    ? Response.json(result.payload, { status, headers: { "cache-control": "private, no-store" } })
    : result.response;
}

export async function repairAgentSenderSnapshots(
  env: Env,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withPostgresMessageRequestScope(env, (scope) => postgresMessageRepairSenderSnapshots(env, input, scope));
}

export type ChannelMessageCommand =
  | "edit-message"
  | "recall-message"
  | "delete-message"
  | "message-reaction"
  | "message-annotation"
  | "message-attachment"
  | "message-rich-reply-app-metadata";

export async function channelMessageCommand(
  env: Env,
  channelId: string,
  family: ChannelMessageCommand,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withPostgresMessageRequestScope(env, async (scope) => {
    const command = family === "message-attachment" && input.action !== "remove"
      ? { ...input, sealedAttachments: await sealAttachments(env, channelId, input) }
      : input;
    const result = await postgresMessageMutation(env, family, command, scope);
    const { tombstoneMessage, editedMessage, ...receipt } = result;
    if (family === "edit-message" && editedMessage && typeof editedMessage === "object" &&
        !Array.isArray(editedMessage)) {
      // Every edit reaches the people reading the Channel as it commits, whoever
      // made it: a person's own edit or the Hub's (the support access note).
      // Agent Instances read edits from history; an update never starts a turn.
      // The edit is committed either way: a reader the update misses sees the
      // Channel's content revision move and reads its history again.
      try {
        const audience = await postgresMessageLiveAudience(env, channelId, scope);
        // What an edit changes and what names the message; what accrues after
        // commit (reactions, thread) stays with the reader's copy.
        const { attachments: _attachments, reactions: _reactions, annotations: _annotations, thread: _thread,
          ...message } = editedMessage as Record<string, unknown>;
        await deliverChannelMessage(env, { ...message, deliveryKind: "update" }, {
          recipientUserIds: audience.recipientUserIds, recipientNotifications: [], instanceOwnerUserIds: [],
        });
      } catch (error) {
        console.warn("Message edit live update failed", { channelId,
          error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (family === "delete-message" || family === "recall-message") {
      if (!tombstoneMessage || typeof tombstoneMessage !== "object" || Array.isArray(tombstoneMessage)) {
        throw new Error("PostgreSQL tombstone delivery evidence is unavailable");
      }
      const audience = await postgresMessageLiveAudience(env, channelId, scope);
      await deliverChannelMessage(env, { ...tombstoneMessage, deliveryKind: "update" }, {
        recipientUserIds: audience.recipientUserIds, recipientNotifications: [],
        instanceOwnerUserIds: audience.instanceOwnerUserIds,
      });
    }
    return receipt;
  });
}

export async function channelMessageAnnotations(
  env: Env,
  input: {
    channelId: string;
    namespace?: string;
    messageId?: string;
    afterCreatedAt?: string;
    principal: AuthorityPrincipal;
  },
): Promise<Record<string, unknown>> {
  return withPostgresMessageRequestScope(env, (scope) => postgresMessageAnnotations(env, input, scope));
}

/** A questionnaire card's settled state as `principal` may read it; undefined while open. */
export async function questionnaireCardState(
  env: Env,
  input: { channelId: string; messageId: string; principal: AuthorityPrincipal },
) {
  return withPostgresMessageRequestScope(env, (scope) => postgresQuestionnaireState(env, input, scope));
}

/** Settle a questionnaire card once, as answered or withdrawn. */
export async function settleQuestionnaireCard(
  env: Env,
  input: Parameters<typeof postgresSettleQuestionnaire>[1],
) {
  return withPostgresMessageRequestScope(env, (scope) => postgresSettleQuestionnaire(env, input, scope));
}

export async function appendChannelMessage(
  env: Env,
  channelId: string,
  command: Record<string, unknown>,
  httpEvidence?: { agentSendFingerprint?: string },
): Promise<Record<string, unknown>> {
  const { committed, billingNotice, spaceId } = await withPostgresMessageRequestScope(env, async (scope) => {
    const placement = await postgresMessageRoute(
      env,
      channelId,
      `message-route:${String(command.commandId || crypto.randomUUID())}`.slice(0, 200),
      scope,
    );
    const { spaceId } = placement;
    const routedCommand = Array.isArray(command.attachments) && command.attachments.length > 0
      ? { ...command, sealedAttachments: await sealAttachments(env, channelId, command) }
      : command;
    const { liveRouting, billingNotice, ...committed } = await postgresMessageAppend(
      env, channelId, routedCommand, { ...scope, spaceId, placement,
        agentSendFingerprint: httpEvidence?.agentSendFingerprint },
    );
    if (isLiveRouting(liveRouting)) committedRouting.set(committed, liveRouting);
    return { committed, billingNotice, spaceId };
  });
  await postBillingNotice(env, channelId, billingNotice);
  // A provider whose terms bound its results' storage: the Space's retention clock deletes this one when due.
  if (typeof command.appAuthorId === "string") {
    await armAppResultRetention(env, spaceId, command.appAuthorId).catch((error: unknown) =>
      console.warn("App result retention could not be armed", { error: error instanceof Error ? error.message : String(error) }));
  }
  return committed;
}

type LiveRouting = MessageLiveRouting;

/* Who a just-committed message reaches, as its append read it in the same
   transaction. Kept beside the receipt, never in it: the receipt goes back to
   the sender, the recipients do not. */
const committedRouting = new WeakMap<object, LiveRouting>();

function isLiveRouting(value: unknown): value is LiveRouting {
  return Boolean(value && typeof value === "object" &&
    Array.isArray((value as LiveRouting).recipientUserIds) &&
    Array.isArray((value as LiveRouting).recipientNotifications) &&
    Array.isArray((value as LiveRouting).instanceOwnerUserIds));
}

/**
 * One committed message (or its tombstone) to everyone it reaches: each
 * reader in their own cell, and the Channel's Agent Instances in their
 * owners' cells. Every cell gets one request saying which of the two it
 * serves, so an Instance receives the message once however many people read
 * the Channel.
 */
async function deliverChannelMessage(
  env: Env,
  payload: Omit<Record<string, unknown>, "recipientUserIds">,
  routing: LiveRouting,
  self?: RuntimeLiveDeliverySelf,
): Promise<Omit<CommandResultInterrupt, "at">[]> {
  const notifications = new Map(routing.recipientNotifications.flatMap((entry) =>
    typeof entry.userId === "string" ? [[entry.userId, entry] as const] : []));
  const audience: RuntimeAudience = {
    humans: routing.recipientUserIds,
    instanceOwners: routing.instanceOwnerUserIds,
  };
  const interrupted = new Map<string, Omit<CommandResultInterrupt, "at">>();
  await deliverToAudience({
    env, audience, label: "Channel", ...(self ? { self } : {}),
    request: (share) => {
      // A notification is named only for a reader it is for: a tombstone carries none.
      const notification = share.human ? notifications.get(share.owner) : undefined;
      return runtimeJsonRequest(RUNTIME_CHANNEL_MESSAGE_URL, {
        ...payload,
        recipientUserIds: share.human ? [share.owner] : [],
        ...(notification ? { recipientNotifications: [notification] } : {}),
        instances: share.instances,
      });
    },
    onResponse: payload.deliveryKind === "update" ? undefined : async (share, response) => {
      if (!share.instances) return;
      const body = await response.json<{ agent?: { interruptedInstances?: unknown } }>().catch(() => null);
      if (!Array.isArray(body?.agent?.interruptedInstances)) return;
      for (const item of body.agent.interruptedInstances) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const instanceId = typeof record.instanceId === "string" ? record.instanceId.trim() : "";
        const agentName = typeof record.agentName === "string" ? record.agentName.trim() : "";
        const ordinal = typeof record.channelInstanceId === "string" ? record.channelInstanceId.trim() : "";
        if (!instanceId || !agentName || interrupted.has(instanceId)) continue;
        interrupted.set(instanceId, {
          instanceId,
          agentName,
          ...(ordinal ? { channelInstanceId: ordinal } : {}),
        });
      }
    },
  });
  return [...interrupted.values()];
}

/** The live routing the append of `committed` read, when this request made it; a replay has none. */
export function committedLiveRouting(committed: Record<string, unknown>): LiveRouting | undefined {
  return committedRouting.get(committed);
}

/**
 * What waits on `subjectId` across the Space, one row for each Channel they
 * may read that has any. One narrow read answers for the whole Space, however
 * many Channels it holds.
 */
export async function readSpaceAttentionProjection(
  env: Env,
  spaceId: string,
  subjectId: string,
): Promise<Record<string, unknown>[]> {
  const match = /^(user|agent):(.+)$/u.exec(subjectId);
  if (!match) throw new Error("Space attention principal is invalid");
  const principal = { kind: match[1] === "user" ? "user" as const : "agent" as const, id: match[2]! };
  const summaries = await channelCatalogAttention(env, { spaceId, principal });
  return summaries.map((summary) => ({ channelId: String(summary.channelId), subjectId, summary }));
}

async function sealAttachments(
  env: Env,
  channelId: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const senderSnapshot = command.senderSnapshot;
  const actorUserId = typeof command.actorUserId === "string"
    ? command.actorUserId
    : typeof command.authorityRootUserId === "string"
      ? command.authorityRootUserId
      : senderSnapshot && typeof senderSnapshot === "object" && !Array.isArray(senderSnapshot) &&
          typeof (senderSnapshot as Record<string, unknown>).userId === "string"
        ? String((senderSnapshot as Record<string, unknown>).userId)
        : "";
  if (!actorUserId) throw new MessageAuthorityError("invalid_command", 400, "Attachment owner is unavailable");
  return sealMessageAttachments(env, {
    channelId,
    messageId: command.messageId,
    actorUserId,
    attachments: command.attachments,
  });
}

export async function channelMessageHistory(
  env: Env,
  input: {
    channelId: string;
    before?: string;
    beforeSequence?: number;
    afterSequence?: number;
    limit?: number;
    senderKind?: "user" | "agent" | "app";
    principal: AuthorityPrincipal;
  },
): Promise<Record<string, unknown>> {
  return withPostgresMessageRequestScope(env, (scope) => postgresMessageHistory(env, input, scope));
}

export async function acknowledgeChannelMessage(
  env: Env,
  channelId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withPostgresMessageRequestScope(env, (scope) => postgresMessageAcknowledge(env, channelId, input, scope));
}

export async function publishChannelLiveDelivery(
  env: Env,
  waitUntil: (task: Promise<unknown>) => void,
  channelId: string,
  payload: Omit<Record<string, unknown>, "recipientUserIds">,
  self?: RuntimeLiveDeliverySelf,
  committedRouting?: LiveRouting,
): Promise<void> {
  // The append read who it reaches as it committed; only a replay reads it again.
  const routing = committedRouting ?? await withPostgresMessageRequestScope(
    env,
    (scope) => postgresMessageLiveDeliveryRouting(
      env, channelId, String(payload.messageId || ""), scope,
    ),
  );
  const delivered = deliverChannelMessage(env, payload, routing, self);
  // The people this message is addressed to are also reached where no client
  // of theirs is open, whether or not one of their cells could be reached.
  const addressed = routing.recipientNotifications.flatMap((entry) => typeof entry.userId === "string" ? [entry.userId] : []);
  if (addressed.length > 0 && env.PUSH_CONFIG) waitUntil(Promise.resolve().then(async () => {
    const config = pushConfig(env.PUSH_CONFIG), devices = pushDevices(env);
    const notifications = await messagePushNotifications({ channelId, payload, userIds: addressed,
      pages: () => pageTitles(env) });
    await Promise.all(notifications.map(({ userIds, notification }) =>
      pushToPeople({ config, devices, userIds, notification })));
  }).catch(() => {
    // Configuration and storage errors can also contain credentials or private
    // query data. Keep the batch diagnostic independent of foreign error text.
    console.error("Push delivery failed");
  }));
  const interruptedInstances = await delivered;
  const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
  if (interruptedInstances.length > 0 && messageId && payload.deliveryKind !== "update") {
    try {
      await recordCommandResult(env, {
        channelId,
        messageId,
        key: "interrupt",
        entry: { interrupts: interruptedInstances },
      });
    } catch (error) {
      console.warn("Interrupt command result recording failed", {
        channelId, messageId, error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function publishChannelMemberRead(
  env: Env,
  input: {
    channelId: string;
    subjectId: string;
    readSequence: number;
    actorUserId: string;
    attention?: import("@xmatrix/protocol").ChannelAttentionSummary;
  },
): Promise<boolean> {

  const recipientUserIds = (await withPostgresMessageRequestScope(
    env,
    (scope) => postgresMessageLiveRecipientUserIds(env, input.channelId, scope),
  )).filter((userId) => userId !== input.actorUserId);
  const readEvent = channelMemberReadEvent(input);
  const attentionEvent = channelAttentionUpdatedEvent(input);
  // The reader is told what now waits on them; everyone else, where they have read to.
  await deliverToAudience({
    env, label: "Channel observable", audience: { humans: [...recipientUserIds, input.actorUserId] },
    request: (share) => runtimeJsonRequest(RUNTIME_CHANNEL_OBSERVABLE_EVENT_URL, {
      recipientUserIds: [share.owner],
      event: share.owner === input.actorUserId ? attentionEvent : readEvent,
    }),
  });
  return true;
}

/**
 * A person decided a card (approved a secret, decided an access request):
 * that answers the wait that card declared on them, and only that one. Their
 * read position does not move. Best effort: the decision already stands, and
 * Done remains.
 */
export async function markCardAnswered(
  env: Env,
  channelId: string,
  messageId: string,
  userId: string,
): Promise<void> {
  try {
    const result = await acknowledgeChannelMessage(env, channelId, {
      commandId: `product:acknowledge-message:${channelId}:${userId}:responded:${crypto.randomUUID()}`.slice(0, 200),
      channelId, principal: { kind: "user", id: userId }, sequence: 0, responded: true, respondedMessageId: messageId,
    });
    if (result.responded !== true) return;
    const attention = result.attention && typeof result.attention === "object" && !Array.isArray(result.attention)
      ? result.attention as import("@xmatrix/protocol").ChannelAttentionSummary : undefined;
    await publishChannelMemberRead(env, {
      channelId, subjectId: `user:${userId}`, readSequence: Number(result.ackedSequence), actorUserId: userId,
      ...(attention ? { attention } : {}),
    });
  } catch (error) {
    console.error("Card answered mark failed", {
      channelId, error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function scheduleChannelLiveDelivery(
  env: Env,
  waitUntil: (task: Promise<unknown>) => void,
  channelId: string,
  payload: Omit<Record<string, unknown>, "recipientUserIds">,
  committedRouting?: LiveRouting,
): void {
  const task = publishChannelLiveDelivery(env, waitUntil, channelId, payload, undefined, committedRouting).catch((error: unknown) => {
    console.error("Channel family live delivery failed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  waitUntil(task);
}

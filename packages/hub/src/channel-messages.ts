import { MessageAuthorityError } from "@xmatrix/db";
import type { AuthorityPrincipal } from "./product-message-command";
import type { Env } from "./types";
import { resolveChannelCatalog } from "./spaces";
import {
  publishRuntimeChannelMessage,
  publishRuntimeChannelObservableEvent,
  type RuntimeLiveDeliverySelf,
} from "./runtime-transport/runtime-route-directory-delivery";
import {
  channelAttentionUpdatedEvent,
  channelMemberReadEvent,
} from "./product-channel-read-fanout";
import { sealMessageAttachments } from "./postgres-content-authority";
import {
  postgresMessageAcknowledge,
  postgresMessageAnnotations,
  postgresMessageAppend,
  postgresMessageErrorResponse,
  postgresMessageHistory,
  postgresMessageLiveDeliveryRouting,
  postgresMessageLiveRecipientUserIds,
  postgresMessageMutation,
  postgresMessageRepairSenderSnapshots,
  postgresMessageRoute,
  withPostgresMessageRequestScope,
} from "./postgres-message-authority";

const MAX_RUNTIME_RECIPIENTS_PER_DELIVERY = 1_000;

function recipientBatches(userIds: string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < userIds.length; offset += MAX_RUNTIME_RECIPIENTS_PER_DELIVERY) {
    batches.push(userIds.slice(offset, offset + MAX_RUNTIME_RECIPIENTS_PER_DELIVERY));
  }
  return batches;
}

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
    const { tombstoneMessage, ...receipt } = result;
    if (family === "delete-message" || family === "recall-message") {
      if (!tombstoneMessage || typeof tombstoneMessage !== "object" || Array.isArray(tombstoneMessage)) {
        throw new Error("PostgreSQL tombstone delivery evidence is unavailable");
      }
      const recipients = await postgresMessageLiveRecipientUserIds(env, channelId, scope);
      const tasks: Promise<unknown>[] = [];
      const responses = await Promise.all(recipientBatches(recipients).map((recipientUserIds) =>
        publishRuntimeChannelMessage({
          env, channelId, waitUntil: (task) => tasks.push(task),
          payload: { ...tombstoneMessage, deliveryKind: "update", recipientUserIds },
        })));
      await Promise.allSettled(tasks);
      if (responses.some((response) => !response.ok)) {
        throw new Error("Runtime rejected PostgreSQL tombstone delivery");
      }
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

export async function appendChannelMessage(
  env: Env,
  channelId: string,
  command: Record<string, unknown>,
  httpEvidence?: { agentSendFingerprint?: string },
): Promise<Record<string, unknown>> {
  return withPostgresMessageRequestScope(env, async (scope) => {
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
    return postgresMessageAppend(
      env, channelId, routedCommand, { ...scope, spaceId, placement,
        agentSendFingerprint: httpEvidence?.agentSendFingerprint },
    );
  });
}

export async function readSpaceAttentionProjection(
  env: Env,
  spaceId: string,
  subjectId: string,
  channelIds: string[],
): Promise<Record<string, unknown>[]> {
  if (channelIds.length === 0) return [];
  if (channelIds.length > 200) throw new Error("Space attention read exceeds 200 Channels");

  const match = /^(user|agent):(.+)$/u.exec(subjectId);
  if (!match) throw new Error("Space attention principal is invalid");
  const principal = { kind: match[1] === "user" ? "user" as const : "agent" as const, id: match[2]! };
  const payload = await resolveChannelCatalog(env, {
    spaceId, principal, channelIds, includeParticipants: false,
  }) as Record<string, unknown>;
  if (!Array.isArray(payload.channels)) throw new Error("PostgreSQL attention response is invalid");
  return payload.channels.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("PostgreSQL attention Channel is invalid");
    }
    const channel = value as Record<string, unknown>;
    if (typeof channel.id !== "string" || !channelIds.includes(channel.id)) {
      throw new Error("PostgreSQL attention Channel binding is invalid");
    }
    return { channelId: channel.id, subjectId, ...(channel.attention ? { summary: channel.attention } : {}) };
  });
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
): Promise<void> {

  const routing = await withPostgresMessageRequestScope(
    env,
    (scope) => postgresMessageLiveDeliveryRouting(
      env, channelId, String(payload.messageId || ""), scope,
    ),
  );
  const responses = await Promise.all(
    recipientBatches(routing.recipientUserIds).map((recipientUserIds) => {
      const recipients = new Set(recipientUserIds);
      return publishRuntimeChannelMessage({
        env,
        waitUntil,
        channelId,
        payload: {
          ...payload,
          recipientUserIds,
          recipientNotifications: routing.recipientNotifications.filter((entry) =>
            typeof entry.userId === "string" && recipients.has(entry.userId)),
        },
        ...(self ? { self } : {}),
      });
    }),
  );
  const rejected = responses.find((response) => !response.ok);
  if (rejected) throw new Error(`RelayRuntime rejected PostgreSQL Channel delivery (${rejected.status})`);
  return;
}

export async function publishChannelMemberRead(
  env: Env,
  waitUntil: (task: Promise<unknown>) => void,
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
  const deliveries = recipientBatches(recipientUserIds).map((recipients) =>
    publishRuntimeChannelObservableEvent({
      env,
      waitUntil,
      channelId: input.channelId,
      payload: {
        recipientUserIds: recipients,
        event: channelMemberReadEvent(input) as unknown as Record<string, unknown>,
      },
    }));
  deliveries.push(publishRuntimeChannelObservableEvent({
    env,
    waitUntil,
    channelId: input.channelId,
    payload: {
      recipientUserIds: [input.actorUserId],
      event: channelAttentionUpdatedEvent(input) as unknown as Record<string, unknown>,
    },
  }));
  const responses = await Promise.all(deliveries);
  if (responses.some((response) => !response.ok)) {
    throw new Error("Runtime rejected PostgreSQL read-state delivery");
  }
  return true;
}

export function scheduleChannelLiveDelivery(
  env: Env,
  waitUntil: (task: Promise<unknown>) => void,
  channelId: string,
  payload: Omit<Record<string, unknown>, "recipientUserIds">,
): void {
  const task = publishChannelLiveDelivery(env, waitUntil, channelId, payload).catch((error: unknown) => {
    console.error("Channel family live delivery failed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  waitUntil(task);
}

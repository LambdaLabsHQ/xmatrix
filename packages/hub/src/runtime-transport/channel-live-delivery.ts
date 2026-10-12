import { plainDeliveryRecord as plainObject } from "./delivery-record";
import { parseChannelTombstoneDelivery } from "./channel-tombstone-delivery";
import { utf8ByteLength, type ChannelAttentionSummary, type ChannelMessageNotification } from "@xmatrix/protocol";
import type { AgentChannelLiveDeliveryInput } from "./agent-instance-port";
import type { HumanChannelLiveDeliveryInput } from "./human-port";

function parseChannelLiveDeliveryCore(input: Record<string, unknown>): AgentChannelLiveDeliveryInput | undefined {
  const update = parseChannelTombstoneDelivery(input);
  if (update === null) return undefined;
  const channelId = typeof input.channelId === "string" ? input.channelId.trim() : undefined;
  // Committed message IDs use the authority's 300-byte limit. Generated
  // notices can exceed the shorter identity bound used by Runtime scopes.
  const messageId = typeof input.messageId === "string" ? input.messageId.trim() : undefined;
  const body = typeof input.body === "string" ? input.body : undefined;
  const sentAt = typeof input.sentAt === "string" && input.sentAt.trim() ? input.sentAt.trim() : undefined;
  const sequence = Number(input.sequence);
  const from = plainObject(input.from);
  if (!channelId || channelId.length > 160 || !messageId || utf8ByteLength(messageId) > 300 || body === undefined || !sentAt || !from ||
      !Number.isSafeInteger(sequence) || sequence < 1) {
    return undefined;
  }
  if (utf8ByteLength(body) > 64 * 1024) return undefined;
  return {
    ...update,
    channelId,
    messageId,
    sequence,
    body,
    from,
    sentAt,
    ...(typeof input.replyToMessageId === "string" && input.replyToMessageId.trim()
      ? { replyToMessageId: input.replyToMessageId.trim().slice(0, 200) }
      : {}),
    ...(plainObject(input.metadata) ? { metadata: plainObject(input.metadata)! } : {}),
    ...(Array.isArray(input.attachments) ? { attachments: input.attachments } : {}),
  };
}

export function parseAgentChannelLiveDelivery(value: unknown): AgentChannelLiveDeliveryInput | undefined {
  const input = plainObject(value);
  const core = input ? parseChannelLiveDeliveryCore(input) : undefined;
  if (!input || !core) return undefined;
  return {
    ...core,
    ...(plainObject(input.replyTo) ? { replyTo: plainObject(input.replyTo)! } : {}),
    ...(Array.isArray(input.appMentions) ? { appMentions: input.appMentions } : {}),
  };
}

export function parseHumanChannelLiveDelivery(value: unknown): HumanChannelLiveDeliveryInput | undefined {
  const input = plainObject(value);
  if (!input) return undefined;
  const core = parseChannelLiveDeliveryCore(input);
  if (!core) return undefined;
  const { channelId } = core;
  const recipientUserIds = Array.isArray(input.recipientUserIds)
    ? input.recipientUserIds
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim().slice(0, 200))
        .slice(0, 1_000)
    : [];
  const recipientSet = new Set(recipientUserIds);
  const recipientNotifications: Array<{
    userId: string;
    notification: ChannelMessageNotification;
  }> = Array.isArray(input.recipientNotifications)
    ? input.recipientNotifications.flatMap((candidate) => {
        const entry = plainObject(candidate);
        const notification = plainObject(entry?.notification);
        const userId = typeof entry?.userId === "string" ? entry.userId.trim().slice(0, 200) : "";
        const reason = notification?.reason;
        if (!userId || !recipientSet.has(userId) ||
            (reason !== "mention" && reason !== "reply" && reason !== "broadcast")) {
          return [];
        }
        const attention = parseChannelAttentionSummary(notification?.attention, channelId);
        if (!attention) return [];
        return [{
          userId,
          notification: {
            reason: reason as ChannelMessageNotification["reason"],
            ...(attention ? { attention } : {}),
          } as ChannelMessageNotification,
        }];
      }).slice(0, 1_000)
    : [];
  if (recipientUserIds.length === 0) return undefined;
  return {
    ...core,
    recipientUserIds,
    recipientNotifications,
    ...(typeof input.clientMessageId === "string" && input.clientMessageId.trim()
      ? { clientMessageId: input.clientMessageId.trim().slice(0, 200) }
      : {}),

  };
}

function parseChannelAttentionSummary(
  value: unknown,
  channelId: string | undefined,
): ChannelAttentionSummary | undefined {
  const input = plainObject(value);
  if (!input || !channelId || input.channelId !== channelId ||
      !Number.isSafeInteger(input.unreadAttentionCount) || Number(input.unreadAttentionCount) < 1 ||
      typeof input.updatedAt !== "string" || !input.updatedAt.trim() || input.updatedAt.length > 64) {
    return undefined;
  }
  const optionalText = (field: unknown, max = 200) =>
    typeof field === "string" && field.trim() && field.length <= max ? field : undefined;
  const triggerKinds = Array.isArray(input.triggerKinds) && input.triggerKinds.length <= 4 &&
      input.triggerKinds.every((kind) =>
        kind === "mention" || kind === "reply" || kind === "quote" || kind === "broadcast")
    ? [...new Set(input.triggerKinds)] as ChannelAttentionSummary["triggerKinds"]
    : undefined;
  const primaryTriggerKind = input.primaryTriggerKind === "mention" ||
      input.primaryTriggerKind === "reply" || input.primaryTriggerKind === "quote" ||
      input.primaryTriggerKind === "broadcast"
    ? input.primaryTriggerKind
    : undefined;
  const lastMessageSequence = Number.isSafeInteger(input.lastMessageSequence) &&
      Number(input.lastMessageSequence) >= 1
    ? Number(input.lastMessageSequence)
    : undefined;
  return {
    channelId,
    unreadAttentionCount: Number(input.unreadAttentionCount),
    updatedAt: input.updatedAt,
    ...(optionalText(input.lastAttentionAt, 64) ? { lastAttentionAt: String(input.lastAttentionAt) } : {}),
    ...(optionalText(input.lastMessageId) ? { lastMessageId: String(input.lastMessageId) } : {}),
    ...(lastMessageSequence !== undefined ? { lastMessageSequence } : {}),
    ...(primaryTriggerKind ? { primaryTriggerKind } : {}),
    ...(triggerKinds ? { triggerKinds } : {}),
  };
}


import type { ChannelMessage, SerializedChannel } from "@xmatrix/protocol";

/** What one arrived message says about its Channel's line in the list. */
export interface ChannelMessageArrival {
  entry: ChannelMessage;
  /** The preview the list shows for it. */
  preview: SerializedChannel["lastMessage"];
  /** The history already held this message: a replay or an echo, not one more. */
  known: boolean;
  /** How many messages the Channel's merged history says it has. */
  historyCount: number;
  /** An activity entry needs no reading (docs/design/conversation-activity.md §3.2). */
  activity: boolean;
}

function time(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function samePreview(left: SerializedChannel["lastMessage"], right: SerializedChannel["lastMessage"]): boolean {
  return left === right || Boolean(left && right && left.messageId === right.messageId &&
    left.sentAt === right.sentAt && left.bodyPreview === right.bodyPreview && left.recalledAt === right.recalledAt);
}

/**
 * The Channel after `arrival`.
 *
 * Its count, history head, activity time and preview only move forward: a
 * frame that comes late leaves a newer line as it is, and the same frame twice
 * changes nothing, in which case the Channel comes back itself. A message
 * without a sequence counts once, when the history did not hold it yet.
 */
export function channelAfterMessage(channel: SerializedChannel, arrival: ChannelMessageArrival): SerializedChannel {
  const { entry } = arrival;
  const held = channel.messageCount || 0;
  const counted = entry.sequence ? entry.sequence : held + (arrival.known ? 0 : 1);
  const messageCount = Math.max(held, arrival.historyCount, counted);
  const historyHeadSequence = entry.sequence
    ? Math.max(channel.historyHeadSequence || 0, entry.sequence)
    : channel.historyHeadSequence;
  // A reader who was caught up before an activity entry stays caught up.
  const readSequence = arrival.activity && channel.readSequence !== undefined && channel.readSequence >= held
    ? Math.max(channel.readSequence, messageCount)
    : channel.readSequence;
  const updatedAt = time(entry.sentAt) > time(channel.updatedAt) ? entry.sentAt : channel.updatedAt;
  const newest = arrival.preview && (!channel.lastMessage || time(arrival.preview.sentAt) >= time(channel.lastMessage.sentAt));
  const lastMessage = newest && !samePreview(arrival.preview, channel.lastMessage) ? arrival.preview : channel.lastMessage;
  if (messageCount === channel.messageCount && historyHeadSequence === channel.historyHeadSequence &&
      readSequence === channel.readSequence && updatedAt === channel.updatedAt && lastMessage === channel.lastMessage) {
    return channel;
  }
  return {
    ...channel,
    messageCount,
    ...(historyHeadSequence !== undefined ? { historyHeadSequence } : {}),
    ...(readSequence !== undefined ? { readSequence } : {}),
    updatedAt,
    ...(lastMessage ? { lastMessage } : {}),
  };
}

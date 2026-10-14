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

const UNPLACED_CHANNELS = 512;
const UNPLACED_ARRIVALS = 32;

/**
 * What one reader's reads have brought, and the messages that got ahead of them.
 *
 * The entity table knows a Channel for this reader once a read made for them
 * has landed: a catalog page, a resolve, their own list. A shared presence
 * frame can show a Channel first, with no read state of theirs, and a message
 * can reach a Channel before any read has. Such a message is kept until the
 * reader's read lands, which can be older than the message and is the first
 * to say what the reader had read.
 */
export function createViewerReads(place: (channel: SerializedChannel, arrival: ChannelMessageArrival) => SerializedChannel = channelAfterMessage) {
  const read = new Set<string>();
  const unplaced = new Map<string, ChannelMessageArrival[]>();
  return {
    /** Whether a read made for this reader has brought the Channel. */
    has: (channelId: string) => read.has(channelId),
    /** A message for a Channel no read of theirs has brought yet. */
    hold(arrival: ChannelMessageArrival) {
      const channelId = arrival.entry.channelId;
      const held = unplaced.get(channelId) ?? [];
      unplaced.delete(channelId);
      unplaced.set(channelId, [...held, arrival].slice(-UNPLACED_ARRIVALS));
      // The longest waiting go first: their read is not coming, or a later message will say as much.
      while (unplaced.size > UNPLACED_CHANNELS) unplaced.delete(unplaced.keys().next().value!);
    },
    /** The Channel as a read for this reader has it, brought up to the messages that got ahead of the read. */
    settle(channel: SerializedChannel): SerializedChannel {
      read.add(channel.id);
      const arrivals = unplaced.get(channel.id);
      if (!arrivals) return channel;
      unplaced.delete(channel.id);
      return arrivals.reduce(place, channel);
    },
  };
}

export type ViewerReads = ReturnType<typeof createViewerReads>;

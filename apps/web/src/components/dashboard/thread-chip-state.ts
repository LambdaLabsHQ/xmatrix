export type ThreadChipState = {
  /** No thread channel exists for this message, so no chip belongs here. */
  present: boolean;
  /** Reply count when the thread has replies, otherwise the bare open label. */
  label: string;
};

const ABSENT: ThreadChipState = { present: false, label: "" };

/**
 * The chip is an opened thread's only representation in its root channel.
 * Threads are no longer started, but the ones opened before stay readable.
 *
 * Presence keys off the id, not the assembled Channel, because the id is what
 * the timeline gates its chip on: a message can know its thread exists before
 * the Channel itself is in hand, and dropping the chip in that window would
 * hide replies that were showing a moment earlier.
 */
export function threadChipState(message: {
  threadChannelId?: string;
  threadChannel?: unknown;
  threadReplyCount?: number;
}): ThreadChipState {
  if (!message.threadChannelId && !message.threadChannel) return ABSENT;
  const replyCount = message.threadReplyCount;
  const replies = typeof replyCount === "number" && Number.isSafeInteger(replyCount) && replyCount > 0
    ? replyCount
    : 0;
  return { present: true, label: `${replies} ${replies === 1 ? "reply" : "replies"} · View in thread` };
}

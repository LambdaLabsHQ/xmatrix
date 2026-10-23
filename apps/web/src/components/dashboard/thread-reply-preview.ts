import { faceOfSender, type ChannelMessage, type FaceOf } from "@xmatrix/protocol";

export type ThreadReplyPreview = {
  id: string;
  author: string;
  face: FaceOf;
  body: string;
};

/** Read-only previews retain thread ownership and include every sender kind. */
export function threadReplyPreviews(
  channelId: string | undefined,
  rootMessageId: string,
  rootCopyMessageId: string | undefined,
  summaryReplies: readonly ChannelMessage[] = [],
  loadedReplies: readonly ChannelMessage[] = [],
): ThreadReplyPreview[] {
  const replies = new Map<string, ChannelMessage>();
  const revision = (message: ChannelMessage) =>
    Date.parse(message.recalledAt || message.editedAt || message.sentAt);
  for (const reply of [...summaryReplies, ...loadedReplies]) {
    if (reply.channelId !== channelId || reply.messageId === rootMessageId ||
        reply.messageId === rootCopyMessageId) continue;
    const previous = replies.get(reply.messageId);
    if (!previous || revision(reply) >= revision(previous)) replies.set(reply.messageId, reply);
  }
  return [...replies.values()]
    .sort((left, right) => left.sequence !== undefined && right.sequence !== undefined
      ? left.sequence - right.sequence
      : Date.parse(left.sentAt) - Date.parse(right.sentAt))
    .slice(-2)
    .map((reply) => ({
      id: reply.messageId,
      author: reply.from.label,
      face: faceOfSender(reply.from),
      body: reply.recalledAt ? "Message recalled" : reply.body ||
        (reply.attachments?.length ? `${reply.attachments.length} attachment${reply.attachments.length === 1 ? "" : "s"}` : ""),
    }));
}

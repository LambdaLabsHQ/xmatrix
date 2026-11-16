/**
 * A system notice replies to what it is about. If that message was deleted
 * while the notice was being worded, the notice still lands without the reply.
 */
export async function appendNoticeWithReplyFallback<T>(append: (replyToMessageId?: string) => Promise<T>,
  replyToMessageId: string, replyTargetGone: (error: unknown) => boolean): Promise<T> {
  try { return await append(replyToMessageId); }
  catch (error) {
    if (!replyTargetGone(error)) throw error;
    return append(undefined);
  }
}

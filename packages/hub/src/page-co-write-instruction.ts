import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";

/**
 * Tells the Agent in a co-writing conversation to co-write its page live, or to stop
 * (docs/design/pages-live-document.md §4.2): a committed instruction its runtime reads, as it
 * reads a switch continuation, and then joins or leaves the page's live session. It is nobody's
 * work: no Agent takes a turn on it, and no person waits on it.
 */
export async function tellPageCoWriter(env: Env, input: {
  spaceId: string; pageId: string; conversationId: string; userId: string; active: boolean;
}): Promise<void> {
  const messageId = `system:page-co-write:${crypto.randomUUID()}`;
  const response = await dispatchProductMessageAppend(env, input.conversationId, {
    commandId: `product:page-co-write:${messageId}`.slice(0, 200),
    messageId,
    channelId: input.conversationId,
    body: input.active ? `Co-writing page:${input.pageId} live.` : `Co-writing page:${input.pageId} ended.`,
    messageKind: "xmatrix.system.page-co-write",
    principal: { kind: "user", id: input.userId },
    xmatrixAuthor: true,
    residual: {
      appMetadata: {
        xmatrixProvenance: "system_fact",
        xmatrixSystemNotice: true,
        xmatrixPageCoWrite: { version: 1, spaceId: input.spaceId, pageId: input.pageId, active: input.active },
      },
    },
  });
  if (!response.ok) throw new Error(`page co-write instruction failed (${response.status})`);
}

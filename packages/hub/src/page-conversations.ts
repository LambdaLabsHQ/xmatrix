import type { PageConversationRecord } from "@xmatrix/db";
import type { PageConversation, PageLink, PageTreeActivity, PageWorkingAgent } from "@xmatrix/protocol";
import { channelHeadPreview } from "./channel-head-preview";

/**
 * A linked conversation as its reader sees it beside the page
 * (docs/design/pages-live-document.md §4.4): the stored newest message
 * becomes a preview with its author's name.
 */
export function pageConversation(record: PageConversationRecord): PageConversation {
  const { head, ...conversation } = record;
  if (!head) return { ...conversation, lastMessage: null };
  const { from, bodyPreview, sentAt } = channelHeadPreview(head);
  const authorKind: string = from.kind;
  const kind = authorKind === "agent" || authorKind === "app" || authorKind === "system"
    ? authorKind : "user";
  return { ...conversation, lastMessage: { from: { kind, label: String(from.label) }, bodyPreview, sentAt } };
}

/**
 * The Agents live in the conversations linked to each section, whether or not
 * they have the page open (pages-live-document.md §3.2). A conversation
 * linked to the whole page counts for the text before the first heading.
 */
export function workingBySection(links: readonly PageLink[],
  conversations: readonly Pick<PageConversation, "conversationId" | "agents">[]): Map<string, PageWorkingAgent[]> {
  const byConversation = new Map(conversations.map((conversation) => [conversation.conversationId, conversation]));
  const out = new Map<string, PageWorkingAgent[]>();
  const seen = new Set<string>();
  for (const link of links) {
    for (const agent of byConversation.get(link.conversationId)?.agents ?? []) {
      const key = `${link.blockId}\u0000${agent.instanceId}\u0000${link.conversationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const working = out.get(link.blockId) ?? [];
      working.push({ name: agent.name, status: agent.status, conversationId: link.conversationId });
      out.set(link.blockId, working);
    }
  }
  return out;
}

/**
 * A page's open discussions for the page tree: how many, how many hold
 * messages this reader has not read, and the newest message in any of them.
 * As beside the page, someone who never opened a discussion has nothing unread there.
 */
export function pageTreeDiscussions(conversationIds: readonly string[],
  conversations: ReadonlyMap<string, PageConversation>): PageTreeActivity["discussions"] {
  let unread = 0;
  let latest: PageConversation["lastMessage"] = null;
  for (const conversationId of conversationIds) {
    const conversation = conversations.get(conversationId);
    if (!conversation) continue;
    if (conversation.readSequence > 0 && conversation.headSequence > conversation.readSequence) unread += 1;
    const message = conversation.lastMessage;
    if (message && (!latest || Date.parse(message.sentAt) > Date.parse(latest.sentAt))) latest = message;
  }
  return { open: conversationIds.length, unread, latest };
}

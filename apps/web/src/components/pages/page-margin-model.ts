import type { PageConversation, PageLink } from "@xmatrix/protocol";

/**
 * Which conversations sit beside a page, where, and in what order
 * (docs/design/pages-live-document.md §4.4). Pure, so the margin, the
 * headings and the footers all read one derivation.
 */

/** How long a conversation stays beside the page after anything last happened in it. */
export const MARGIN_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** Space between two cards in the margin, in pixels. */
export const MARGIN_GAP = 8;

export type MarginAgent = PageConversation["agents"][number];

export interface MarginConversation {
  conversationId: string;
  name: string | null;
  /**
   * Where it sits: `text:<linkId>` beside a discussion's passage,
   * `block:<blockId>` beside a section's heading, or `page` beside the title.
   */
  anchor: string;
  blockId: string;
  /** An open discussion's passage, and the link that resolves it. */
  quote: string | null;
  linkId: string | null;
  lastMessage: PageConversation["lastMessage"];
  agents: MarginAgent[];
  unread: number;
  activityAt: string;
  /** In the margin now; otherwise it has sunk into its section's footer and the conversation list. */
  live: boolean;
  /** A discussion whose outcome is written into the page. */
  resolved: boolean;
}

/** What this client already knows live about a conversation; newer facts win over the page's listing. */
export interface LiveConversation {
  name?: string | null;
  lastMessage?: PageConversation["lastMessage"];
  agents?: MarginAgent[];
  headSequence?: number;
  readSequence?: number;
}

/** A discussion's passage first, then a section, then the whole page. */
function placement(link: PageLink): number {
  if (link.anchor && !link.resolvedAt) return 0;
  return link.blockId ? 1 : 2;
}

export function anchorOf(link: PageLink): string {
  if (link.anchor && !link.resolvedAt) return `text:${link.linkId}`;
  return link.blockId ? `block:${link.blockId}` : "page";
}

function newest<T extends { sentAt: string } | null | undefined>(left: T, right: T): T {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right.sentAt) > Date.parse(left.sentAt) ? right : left;
}

function later(left: string, right: string | undefined): string {
  return right && Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * One entry per conversation linked to the page, placed by its most specific
 * link. `conversations` is the page's listing of them for this reader; a link
 * whose conversation the listing leaves out is one the reader cannot open.
 * An older Hub lists none, and then every link still shows, by what is known.
 */
export function marginConversations(input: {
  links: readonly PageLink[];
  conversations?: readonly PageConversation[];
  live?: (conversationId: string) => LiveConversation | null;
  now: number;
}): MarginConversation[] {
  const listed = input.conversations ? new Map(input.conversations.map((item) => [item.conversationId, item])) : null;
  const byConversation = new Map<string, PageLink[]>();
  for (const link of input.links) {
    const links = byConversation.get(link.conversationId) ?? [];
    links.push(link);
    byConversation.set(link.conversationId, links);
  }
  const out: MarginConversation[] = [];
  for (const [conversationId, links] of byConversation) {
    const summary = listed ? listed.get(conversationId) : null;
    if (listed && !summary) continue;
    const link = [...links].sort((a, b) => placement(a) - placement(b))[0]!;
    const live = input.live?.(conversationId) ?? null;
    const lastMessage = newest(summary?.lastMessage ?? null, live?.lastMessage ?? null);
    const head = Math.max(summary?.headSequence ?? 0, live?.headSequence ?? 0);
    const read = Math.max(summary?.readSequence ?? 0, live?.readSequence ?? 0);
    // Someone who never opened it has nothing unread there; it is not theirs to catch up on.
    const unread = read > 0 ? Math.max(0, head - read) : 0;
    const agents = live?.agents ?? summary?.agents ?? [];
    const activityAt = later(later(summary?.activityAt ?? link.lastSeenAt, link.lastSeenAt), lastMessage?.sentAt);
    const discussion = placement(link) === 0;
    out.push({
      conversationId,
      name: live?.name || summary?.name || null,
      anchor: anchorOf(link),
      blockId: link.blockId,
      quote: discussion ? link.anchor!.quote : null,
      linkId: discussion ? link.linkId : null,
      lastMessage,
      agents,
      unread,
      activityAt,
      live: discussion || agents.length > 0 || unread > 0 || input.now - Date.parse(activityAt) < MARGIN_ACTIVE_MS,
      resolved: !discussion && links.some((item) => Boolean(item.anchor && item.resolvedAt)),
    });
  }
  return out;
}

/**
 * The margin while a conversation is open in it: that one is shown even when it
 * has sunk, and one the page does not link yet sits beside the title.
 */
export function withOpenConversation(conversations: readonly MarginConversation[], openId: string | null,
  name: string | null = null): MarginConversation[] {
  if (!openId) return [...conversations];
  if (conversations.some((item) => item.conversationId === openId)) {
    return conversations.map((item) => item.conversationId === openId ? { ...item, live: true } : item);
  }
  return [...conversations, { conversationId: openId, name, anchor: "page", blockId: "", quote: null, linkId: null,
    lastMessage: null, agents: [], unread: 0, activityAt: new Date(0).toISOString(), live: true, resolved: false }];
}

/** Per section: how many conversations are about it, and how many of those have gone quiet. */
export function sectionConversationCounts(conversations: readonly MarginConversation[]):
  Map<string, { total: number; quiet: number }> {
  const counts = new Map<string, { total: number; quiet: number }>();
  for (const conversation of conversations) {
    const count = counts.get(conversation.blockId) ?? { total: 0, quiet: 0 };
    count.total += 1;
    if (!conversation.live) count.quiet += 1;
    counts.set(conversation.blockId, count);
  }
  return counts;
}

/** Where an anchor is, falling back to its section and then the top when its text is gone. */
export function anchorTop(tops: ReadonlyMap<string, number>, conversation: Pick<MarginConversation, "anchor" | "blockId">):
  number {
  return tops.get(conversation.anchor) ?? tops.get(conversation.blockId ? `block:${conversation.blockId}` : "page")
    ?? tops.get("page") ?? 0;
}

/**
 * Card positions in the margin, as comments in Google Docs: each card as close
 * to its anchor as the cards before it allow. A focused card sits exactly at
 * its anchor, and the cards before it move up to make room.
 */
export function layoutMargin(cards: ReadonlyArray<{ id: string; top: number; height: number }>,
  focusedId: string | null = null): Map<string, number> {
  const placed = [...cards].sort((a, b) => a.top - b.top || a.id.localeCompare(b.id));
  const out = new Map<string, number>();
  const pivot = focusedId ? placed.findIndex((card) => card.id === focusedId) : -1;
  if (pivot < 0) {
    let bottom = Number.NEGATIVE_INFINITY;
    for (const card of placed) {
      const top = Math.max(card.top, bottom + MARGIN_GAP);
      out.set(card.id, top);
      bottom = top + card.height;
    }
    return out;
  }
  const focused = placed[pivot]!;
  out.set(focused.id, focused.top);
  let bottom = focused.top + focused.height;
  for (const card of placed.slice(pivot + 1)) {
    const top = Math.max(card.top, bottom + MARGIN_GAP);
    out.set(card.id, top);
    bottom = top + card.height;
  }
  let ceiling = focused.top;
  for (const card of placed.slice(0, pivot).reverse()) {
    const top = Math.min(card.top, ceiling - MARGIN_GAP - card.height);
    out.set(card.id, top);
    ceiling = top;
  }
  // Nothing goes above the page: the whole column moves down instead.
  if (ceiling < 0) for (const [id, top] of out) out.set(id, top - ceiling);
  return out;
}

/**
 * Starting a conversation from a selected passage, of a page or of a message
 * (docs/design/pages-and-conversations.md §3.2): the new conversation is named
 * by the passage, and its first message opens with the passage and a link back
 * to where it came from (`discussionHead` in @xmatrix/protocol), the context
 * every Agent in the conversation reads, in the conversation itself. People see
 * the passage once: a page's passage is its discussion's anchor, which its
 * margin thread shows as its head, and which opens its first message anywhere
 * else; a message's passage shows above the composer until it is sent.
 */
import { discussionHead, splitDiscussionHead } from "@xmatrix/protocol";

/** Longest passage carried into the new conversation's first message. */
export const MAX_DISCUSSION_QUOTE_CHARS = 4000;

/** Longest passage used as the conversation's name. */
const MAX_DISCUSSION_TITLE_CHARS = 60;

/** A discussion of a passage is named by the passage. */
export function discussionTitle(quote: string): string {
  const line = quote.trim().replace(/\s+/gu, " ");
  return `“${line.length > MAX_DISCUSSION_TITLE_CHARS ? `${line.slice(0, MAX_DISCUSSION_TITLE_CHARS - 1)}…` : line}”`;
}

/** The passage a new conversation was started from, and where it came from. */
export type DiscussionQuote = {
  text: string;
  label: string;
  href: string;
  /**
   * A page's passage anchors its discussion, and the thread shows it; a
   * message's passage has nowhere else to show, so the composer does.
   */
  anchored: boolean;
};

/** The passage as its conversation carries it: trimmed, and cut to the carried bound. */
export function discussionQuote(quote: string, source: { label: string; href: string },
  anchored: boolean): DiscussionQuote {
  const text = quote.trim().length > MAX_DISCUSSION_QUOTE_CHARS
    ? `${quote.trim().slice(0, MAX_DISCUSSION_QUOTE_CHARS - 1)}…` : quote.trim();
  return { text, label: source.label.trim().replace(/\s+/gu, " ") || "source", href: source.href, anchored };
}

/**
 * The first message of a discussion: the passage as a Markdown quote, where it
 * came from, then what was typed, with the typed Agent selections moved past
 * the quote. A mention inside the quote stays quoted text; it never summons
 * anyone.
 */
export function quotedMessage<T extends { start: number; end: number }>(quote: DiscussionQuote,
  typed: { body: string; selections: T[] }): { body: string; selections: T[] } {
  const head = discussionHead(quote.text, quote);
  return { body: head + typed.body, selections: typed.selections.map((selection) =>
    ({ ...selection, start: selection.start + head.length, end: selection.end + head.length })) };
}

/** A link to a page of this app (`…/pages?page=<id>`), as a page's discussion links back to it. */
const PAGE_LINK = /\/pages\?(?:[^#]*&)?page=/u;

/**
 * A message as a page's margin thread or a preview shows it. A page
 * discussion's first message shows only what was written: its passage is the
 * thread's anchor, already shown above it, and its link back leads to the page
 * the thread sits beside.
 */
export function foldedDiscussionBody(body: string): string {
  const head = splitDiscussionHead(body);
  return head && PAGE_LINK.test(head.href) && head.rest.trim() ? head.rest : body;
}

/** The passage selected inside one message's text, and where it sits on screen. */
export type MessagePassageSelection = { messageId: string; quote: string; rect: DOMRect };

/** Marks the element holding a message's text; its value is the message id. */
export const MESSAGE_BODY_ATTRIBUTE = "data-message-body";

/**
 * The passage `selection` covers when it lies within a single message's text
 * inside `root`. A selection spanning messages, or reaching past a message's
 * text into its header or actions, is not a passage of one message.
 */
export function selectedMessagePassage(selection: Selection | null, root: Element): MessagePassageSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const bodyOf = (node: Node | null) => (node && (node.nodeType === 1 ? node as Element : node.parentElement))
    ?.closest(`[${MESSAGE_BODY_ATTRIBUTE}]`) ?? null;
  const body = bodyOf(selection.anchorNode);
  if (!body || body !== bodyOf(selection.focusNode) || !root.contains(body)) return null;
  const messageId = body.getAttribute(MESSAGE_BODY_ATTRIBUTE);
  const quote = selection.toString().replace(/\n{3,}/gu, "\n\n").trim();
  if (!messageId || !quote) return null;
  return { messageId, quote, rect: selection.getRangeAt(0).getBoundingClientRect() };
}

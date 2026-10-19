/**
 * Starting a conversation from a selected passage, of a page or of a message
 * (docs/design/pages-and-conversations.md §3.2): the new conversation is named
 * by the passage, and its composer opens holding the passage as a quote with a
 * link back to where it came from. Sent, that first message is the context
 * every Agent in the conversation reads, in the conversation itself.
 */

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
export type DiscussionQuote = { text: string; label: string; href: string };

/** The passage as its conversation carries it: trimmed, and cut to the carried bound. */
export function discussionQuote(quote: string, source: { label: string; href: string }): DiscussionQuote {
  const text = quote.trim().length > MAX_DISCUSSION_QUOTE_CHARS
    ? `${quote.trim().slice(0, MAX_DISCUSSION_QUOTE_CHARS - 1)}…` : quote.trim();
  return { text, label: source.label.trim().replace(/\s+/gu, " ") || "source", href: source.href };
}

/**
 * The first message of a discussion: the passage as a Markdown quote, where it
 * came from, then what was typed, with the typed Agent selections moved past
 * the quote. A mention inside the quote stays quoted text; it never summons
 * anyone.
 */
export function quotedMessage<T extends { start: number; end: number }>(quote: DiscussionQuote,
  typed: { body: string; selections: T[] }): { body: string; selections: T[] } {
  const quoted = quote.text.split(/\r?\n/u).map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">")).join("\n");
  const label = quote.label.replace(/[[\]\\]/gu, "\\$&");
  const head = `${quoted}\n\n— [${label}](${quote.href})\n\n`;
  return { body: head + typed.body, selections: typed.selections.map((selection) =>
    ({ ...selection, start: selection.start + head.length, end: selection.end + head.length })) };
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

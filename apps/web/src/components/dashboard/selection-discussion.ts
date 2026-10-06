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

/**
 * The draft a discussion opens with: the passage as a Markdown quote, then
 * where it came from. A mention inside the quote stays quoted text; it
 * never summons anyone.
 */
export function discussionDraft(quote: string, source: { label: string; href: string }): string {
  const text = quote.trim().length > MAX_DISCUSSION_QUOTE_CHARS
    ? `${quote.trim().slice(0, MAX_DISCUSSION_QUOTE_CHARS - 1)}…` : quote.trim();
  const quoted = text.split(/\r?\n/u).map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">")).join("\n");
  const label = source.label.trim().replace(/\s+/gu, " ").replace(/[[\]\\]/gu, "\\$&") || "source";
  return `${quoted}\n\n— [${label}](${source.href})\n\n`;
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

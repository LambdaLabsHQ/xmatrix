/**
 * References in message text (docs/design/pages-and-conversations.md §4.3): a
 * message names a channel as `channel:<id>` and a page as `page:<id>`, with an
 * optional `#<section>`. The id is the reference; clients draw the current
 * name for a reader who can see the target, so renames never break old
 * messages and a reference grants nothing.
 */
import { pageReferenceSpans, type PageReferenceSpan } from "./page-markdown.js";

const CHANNEL_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHANNEL_REFERENCE_SPAN = new RegExp(`\\bchannel:(${CHANNEL_ID})\\b`, "giu");

/** The text a message carries to refer to a channel. */
export function channelReferenceToken(channelId: string): string {
  return `channel:${channelId.toLowerCase()}`;
}

/** One `channel:<id>` span in message text, ready to replace with a live chip. */
export interface ChannelReferenceSpan {
  channelId: string;
  start: number;
  end: number;
  text: string;
}

export function channelReferenceSpans(text: string): ChannelReferenceSpan[] {
  return [...text.matchAll(CHANNEL_REFERENCE_SPAN)].map((match) => ({
    channelId: match[1]!.toLowerCase(),
    start: match.index!,
    end: match.index! + match[0].length,
    text: match[0],
  }));
}

export type MessageReferenceSpan =
  | ({ kind: "page" } & PageReferenceSpan)
  | ({ kind: "channel" } & ChannelReferenceSpan);

/** Every page and channel reference in text order. */
export function messageReferenceSpans(text: string): MessageReferenceSpan[] {
  return [
    ...pageReferenceSpans(text).map((span) => ({ kind: "page" as const, ...span })),
    ...channelReferenceSpans(text).map((span) => ({ kind: "channel" as const, ...span })),
  ].sort((a, b) => a.start - b.start);
}

/** When an inline code span is only a reference, promote it to a chip. */
export function loneMessageReference(text: string): MessageReferenceSpan | null {
  const trimmed = text.trim();
  const [span, extra] = messageReferenceSpans(trimmed);
  return span && !extra && span.start === 0 && span.end === trimmed.length ? span : null;
}

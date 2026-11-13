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

/**
 * A request a Norn program made, named by its reference: `request:<ref>`. A
 * reader sees what was asked, of whom and how it stands, never the reference.
 */
const REQUEST_REFERENCE_SPAN = /\brequest:(r[a-z0-9]{6,40})\b/gu;

/** The text a message carries to refer to a request. */
export function requestReferenceToken(requestRef: string): string {
  return `request:${requestRef}`;
}

export interface RequestReferenceSpan { requestRef: string; start: number; end: number; text: string }

export function requestReferenceSpans(text: string): RequestReferenceSpan[] {
  return [...text.matchAll(REQUEST_REFERENCE_SPAN)].map((match) => ({
    requestRef: match[1]!, start: match.index!, end: match.index! + match[0].length, text: match[0],
  }));
}

/** A request as whoever can read its conversation sees it in place of its reference. */
export interface NornRequestView {
  ref: string;
  channelId: string;
  holder: string;
  text: string;
  /** How it stands: open, or how it ended. */
  state: "open" | "answered" | "refused" | "broke" | "no_reply" | "cancelled" | "revoked";
  /** The answer, or the reason it was refused or could not be done. */
  reply: string | null;
}

export type MessageReferenceSpan =
  | ({ kind: "page" } & PageReferenceSpan)
  | ({ kind: "channel" } & ChannelReferenceSpan)
  | ({ kind: "request" } & RequestReferenceSpan);

/** Every page, channel and request reference in text order. */
export function messageReferenceSpans(text: string): MessageReferenceSpan[] {
  return [
    ...pageReferenceSpans(text).map((span) => ({ kind: "page" as const, ...span })),
    ...channelReferenceSpans(text).map((span) => ({ kind: "channel" as const, ...span })),
    ...requestReferenceSpans(text).map((span) => ({ kind: "request" as const, ...span })),
  ].sort((a, b) => a.start - b.start);
}

/** When an inline code span is only a reference, promote it to a chip. */
export function loneMessageReference(text: string): MessageReferenceSpan | null {
  const trimmed = text.trim();
  const [span, extra] = messageReferenceSpans(trimmed);
  return span && !extra && span.start === 0 && span.end === trimmed.length ? span : null;
}

/**
 * Text with each reference drawn as its label, for previews that cannot hold a
 * chip (list rows, notifications). A target the reader cannot see reads as
 * "Page" or "Channel"; a locator is never shown, not even one a stored preview
 * cut short.
 */
export function messageReferenceLabels(text: string, names: {
  page?: (pageId: string) => string | undefined;
  channel?: (channelId: string) => string | undefined;
  request?: (requestRef: string) => string | undefined;
}): string {
  let result = "";
  let cursor = 0;
  for (const span of messageReferenceSpans(text)) {
    result += text.slice(cursor, span.start);
    if (span.kind === "page") {
      result += names.page?.(span.pageId)?.trim() || "Page";
      if (span.blockId) result += " › Section";
      if (span.revision != null) result += ` (r${span.revision})`;
    } else if (span.kind === "request") {
      result += names.request?.(span.requestRef)?.trim() || "a request";
    } else {
      result += names.channel?.(span.channelId)?.trim() || "Channel";
    }
    cursor = span.end;
  }
  result += text.slice(cursor);
  return result.replace(/\b(page|channel):[0-9a-f-]+(?:\.{3}|…)?$/iu,
    (_, kind: string) => kind.toLowerCase() === "page" ? "Page" : "Channel");
}

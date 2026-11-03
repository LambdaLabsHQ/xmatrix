/**
 * A quote of a message in the conversation it is read in (selection-discussion.ts) is the reference itself: the
 * quoted words, which open the message they came from with those words marked. Naming the conversation the reader
 * is already in, or the message's author and time, adds nothing the jump does not show.
 */
import { createContext } from "react";
import type { ChannelSnapshot } from "@xmatrix/protocol";
import { parseInternalChannelLink, resolveChannelRouteKey } from "./channel-links";

/** The conversation a timeline shows, and how it opens one of its messages. */
export type CitingConversation = { channel: ChannelSnapshot; openMessage: (messageId: string) => void };

/** The conversation on screen; outside a conversation's timeline, none. */
export const CitingConversationContext = createContext<CitingConversation | null>(null);

/** The message in `channel` a quote's link leads to, or undefined for a link anywhere else. */
export function messageHere(href: string, channel: ChannelSnapshot): string | undefined {
  const link = typeof window === "undefined" ? null : parseInternalChannelLink(href, window.location.href);
  if (!link?.messageId) return undefined;
  return resolveChannelRouteKey([channel], link.channelKey, null)?.id === channel.id ? link.messageId : undefined;
}

/** The passage whose quote was opened last, marked in its message once the jump lands there. */
let openedPassage: { messageId: string; quote: string } | null = null;

export function notePassageOpened(messageId: string, quote: string) {
  openedPassage = { messageId, quote };
}

/** The quoted words opened in `messageId`, once: a later jump to the same message marks only its row. */
export function takeOpenedPassage(messageId: string): string | null {
  if (openedPassage?.messageId !== messageId) return null;
  const { quote } = openedPassage;
  openedPassage = null;
  return quote;
}

export const PASSAGE_HIGHLIGHT = "cited-passage";

/**
 * The range of `quote` in `body`'s text, matched without regard to whitespace, since a selection's text breaks
 * lines where the rendered text has blocks.
 */
export function passageRange(body: Element, quote: string): Range | null {
  const needle = quote.replace(/\s+/gu, "");
  if (!needle) return null;
  const chars: { node: Text; offset: number }[] = [];
  let text = "";
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data;
    for (let offset = 0; offset < value.length; offset += 1) {
      if (/\s/u.test(value[offset]!)) continue;
      chars.push({ node, offset });
      text += value[offset];
    }
  }
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = chars[at]!;
  const end = chars[at + needle.length - 1]!;
  const range = body.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

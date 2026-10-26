import { messageReferenceSpans } from "@xmatrix/protocol";
import type { MessageReferenceCatalog } from "./message-reference-catalog";
import { channelLabel } from "./reference-complete";

/** Plain labels for compact previews, including inside another clickable card. Never expose a locator. */
export function referencePreview(text: string, catalog: MessageReferenceCatalog | null): string {
  const spans = messageReferenceSpans(text);
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start);
    if (span.kind === "page") {
      result += catalog?.pages?.find((page) => page.pageId === span.pageId)?.title.trim() || "Page";
      if (span.blockId) result += " › Section";
      if (span.revision != null) result += ` (r${span.revision})`;
    } else {
      const channel = catalog?.channels.find((channel) => channel.id === span.channelId);
      result += channel ? channelLabel(channel) : "Channel";
    }
    cursor = span.end;
  }
  result += text.slice(cursor);
  // Stored previews may end in the middle of a UUID. That fragment is still a locator, not a label.
  return result.replace(/\b(page|channel):[0-9a-f-]+(?:\.{3}|…)?$/iu,
    (_, kind: string) => kind.toLowerCase() === "page" ? "Page" : "Channel");
}

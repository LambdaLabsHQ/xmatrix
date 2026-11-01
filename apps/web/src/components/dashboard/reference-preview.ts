import { messageReferenceLabels } from "@xmatrix/protocol";
import type { MessageReferenceCatalog } from "./message-reference-catalog";
import { channelLabel } from "./reference-complete";

/** Plain labels for compact previews, including inside another clickable card. Never expose a locator. */
export function referencePreview(text: string, catalog: MessageReferenceCatalog | null): string {
  return messageReferenceLabels(text, {
    page: (pageId) => catalog?.pages?.find((page) => page.pageId === pageId)?.title,
    channel: (channelId) => {
      const channel = catalog?.channels.find((item) => item.id === channelId);
      return channel ? channelLabel(channel) : undefined;
    },
  });
}

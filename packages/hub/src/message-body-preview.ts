import { splitDiscussionHead } from "@xmatrix/protocol";

/**
 * The one-line, 240-character body shown in Channel and Space previews. A
 * discussion's first message previews as what was written: its passage is
 * already the conversation's name and its anchor. A preview drawn for one
 * reader passes `label` to turn its references into names.
 */
export function compactMessageBodyPreview(body: string, label: (text: string) => string = (text) => text): string {
  const head = splitDiscussionHead(body);
  // Labels go in before the cut, so a cut never lands inside a locator.
  const normalized = label(head?.rest.trim() ? head.rest : body).trim().replace(/\s+/gu, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

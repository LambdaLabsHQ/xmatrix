import { splitDiscussionHead } from "@xmatrix/protocol";

/**
 * The one-line, 240-character body shown in Channel and Space previews. A
 * discussion's first message previews as what was written: its passage is
 * already the conversation's name and its anchor.
 */
export function compactMessageBodyPreview(body: string): string {
  const head = splitDiscussionHead(body);
  const normalized = (head?.rest.trim() ? head.rest : body).trim().replace(/\s+/gu, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

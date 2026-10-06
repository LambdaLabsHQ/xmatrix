/** The one-line, 240-character body shown in Channel and Space previews. */
export function compactMessageBodyPreview(body: string): string {
  const normalized = body.trim().replace(/\s+/gu, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

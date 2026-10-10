/** The name of the one live session a page has. */
export function pageSessionId(spaceId: string, pageId: string): string {
  return `${spaceId}\u0000${pageId}`;
}

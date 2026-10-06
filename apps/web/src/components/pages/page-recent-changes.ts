import type { PageRecentChange } from "@xmatrix/protocol";

/** Recent changes the Pages list shows, and how many once the reader asks for more. */
export const RECENT_CHANGES = 3;
export const MORE_RECENT_CHANGES = 10;

/** A recent change's second line, as a conversation row's preview: who, then what they wrote. */
export function pageRecentChangePreview(change: Pick<PageRecentChange, "authors" | "gist" | "created">): string {
  const who = [...new Set(change.authors.map((author) => author.label))].join(", ");
  const what = change.gist ?? (change.created ? "Created the page" : "Edited");
  return who ? `${who}: ${what}` : what;
}

/**
 * Moves whenever a page's head does, or a page comes or goes: Recent changes
 * is read again only then, riding the tree's own refresh.
 */
export function pageTreeHeadKey(pages: ReadonlyArray<{ headRevision: number; updatedAt: string }>): string {
  let revisions = 0;
  let latest = "";
  for (const page of pages) {
    revisions += page.headRevision;
    if (page.updatedAt > latest) latest = page.updatedAt;
  }
  return `${pages.length}:${revisions}:${latest}`;
}

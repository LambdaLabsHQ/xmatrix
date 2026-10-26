import { pagePositionBetween } from "@xmatrix/protocol";

/** A page the tree can place. `parentPageId` is the stored parent; a parent the reader cannot open is treated as none. */
export interface PagePlaceInput {
  pageId: string;
  parentPageId: string | null;
  position: string;
  canEdit: boolean;
}

/**
 * Where a dragged page lands. `afterPageId` null appends after the last sibling of `parentPageId`;
 * `beforePageId` places it immediately before that sibling. Exactly one of the two is set.
 */
export interface PageDrop {
  parentPageId: string | null;
  afterPageId?: string | null;
  beforePageId?: string;
}

export type PageDropEdge = "above" | "below";

function visibleParent(page: PagePlaceInput, known: ReadonlySet<string>): string | null {
  return page.parentPageId && known.has(page.parentPageId) ? page.parentPageId : null;
}

function byPosition(a: PagePlaceInput, b: PagePlaceInput): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.pageId.localeCompare(b.pageId);
}

function siblingsOf(pages: readonly PagePlaceInput[], parent: string | null, known: ReadonlySet<string>): PagePlaceInput[] {
  return pages.filter((page) => visibleParent(page, known) === parent).sort(byPosition);
}

/** Whether `pageId` is `ancestorId` or sits under it, as far as this reader can see. */
function isWithin(byId: ReadonlyMap<string, PagePlaceInput>, known: ReadonlySet<string>, ancestorId: string, pageId: string): boolean {
  let current: string | null = pageId;
  for (let depth = 0; current && depth < 64; depth++) {
    if (current === ancestorId) return true;
    const parent: string | null = byId.get(current)?.parentPageId ?? null;
    current = parent && known.has(parent) ? parent : null;
  }
  return false;
}

/**
 * The move that drops `draggedId` on the top or bottom half of `targetId`.
 * The bottom half places it immediately after that page, as the same kind of sibling;
 * the top half places it immediately before. Nothing moves when it is already there,
 * when the page cannot be edited, or when the target sits inside the dragged page.
 */
export function pageDropAt(pages: readonly PagePlaceInput[], draggedId: string, targetId: string, edge: PageDropEdge): PageDrop | null {
  if (draggedId === targetId) return null;
  const byId = new Map(pages.map((page) => [page.pageId, page]));
  const dragged = byId.get(draggedId);
  const target = byId.get(targetId);
  if (!dragged?.canEdit || !target) return null;
  const known = new Set(byId.keys());
  if (isWithin(byId, known, draggedId, targetId)) return null;
  const parent = visibleParent(target, known);
  if (parent && !byId.get(parent)?.canEdit) return null;
  if (parent && isWithin(byId, known, draggedId, parent)) return null;
  const siblings = siblingsOf(pages, parent, known);
  const targetIndex = siblings.findIndex((page) => page.pageId === targetId);
  const draggedIndex = siblings.findIndex((page) => page.pageId === draggedId);
  if (targetIndex < 0) return null;
  if (edge === "below") {
    if (draggedIndex === targetIndex + 1) return null;
    return { parentPageId: parent, afterPageId: targetId };
  }
  if (draggedIndex >= 0 && draggedIndex === targetIndex - 1) return null;
  const previous = siblings[targetIndex - 1];
  if (!previous || previous.pageId === draggedId) return { parentPageId: parent, beforePageId: targetId };
  return { parentPageId: parent, afterPageId: previous.pageId };
}

/** The tree with one page moved, ordered by the same between-key the store will write. */
export function pageTreeAfterDrop<T extends PagePlaceInput>(pages: readonly T[], draggedId: string, drop: PageDrop): T[] {
  const dragged = pages.find((page) => page.pageId === draggedId);
  if (!dragged) return [...pages];
  const known = new Set(pages.map((page) => page.pageId));
  const siblings = siblingsOf(pages.filter((page) => page.pageId !== draggedId), drop.parentPageId, known);
  let before: string | null = null;
  let after: string | null = null;
  if (drop.beforePageId) {
    const index = siblings.findIndex((page) => page.pageId === drop.beforePageId);
    if (index < 0) return [...pages];
    before = index > 0 ? siblings[index - 1]!.position : null;
    after = siblings[index]!.position;
  } else if (drop.afterPageId) {
    const index = siblings.findIndex((page) => page.pageId === drop.afterPageId);
    if (index < 0) return [...pages];
    before = siblings[index]!.position;
    after = siblings[index + 1]?.position ?? null;
  } else {
    before = siblings.at(-1)?.position ?? null;
  }
  let position: string;
  try {
    position = pagePositionBetween(before, after);
  } catch {
    return [...pages];
  }
  return pages.map((page) => page.pageId === draggedId ? { ...page, parentPageId: drop.parentPageId, position } : page);
}

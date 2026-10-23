"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pageApi } from "@/lib/pages/page-client";

export type PageCreation = ReturnType<typeof usePageCreation>;

/** What a new page is called until its author names it on the page itself. */
export const NEW_PAGE_TITLE = "Untitled";

/** Where a page opened with + is, until the first write on it makes it. */
export const NEW_PAGE_ID = "new";

/** A document's Yjs state as base64, a chunk at a time so a long first paste does not overflow the stack. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Like Notion: + opens a new page at once, as any page opens, its title ready to type. It is made on
 * the first write on it, copy-on-write, from the document as written so far, so one left empty is not
 * kept anywhere. Shared by the tree, the phone FAB and the desktop shortcut.
 */
export function usePageCreation(spaceId: string | null, token: string, openPage: (pageId: string) => void) {
  const queryClient = useQueryClient();
  // The page a new page goes under once it is made.
  const [parentPageId, setParentPageId] = useState<string | null>(null);
  useEffect(() => setParentPageId(null), [spaceId]);

  const create = useCallback((parent: string | null) => {
    if (!spaceId) return;
    setParentPageId(parent);
    openPage(NEW_PAGE_ID);
  }, [openPage, spaceId]);

  /** Makes the new page from the document written on it so far. */
  const make = useCallback(async (document: Uint8Array) => {
    if (!spaceId) throw new Error("No Space to make the page in");
    const { page, seeded } = await pageApi.create(spaceId, token, { parentPageId, document: base64(document) });
    await queryClient.invalidateQueries({ queryKey: ["xmatrix"], predicate: (query) => query.queryKey.includes("page-tree") });
    return { pageId: page.pageId, seeded: seeded === true };
  }, [parentPageId, queryClient, spaceId, token]);
  return { create, make, parentPageId };
}

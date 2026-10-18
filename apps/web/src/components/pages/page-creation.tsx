"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pageApi } from "@/lib/pages/page-client";
import { userErrorMessage } from "@/lib/user-facing-error";

export type PageCreation = ReturnType<typeof usePageCreation>;

/** What a new page is called until its author names it on the page itself. */
export const NEW_PAGE_TITLE = "Untitled";

/** Where a page made with + is open until something is written on it: it exists only here until then. */
export const NEW_PAGE_ID = "new";

/**
 * Like Notion: + opens an untitled page at once with its title ready to type over.
 * The page is made only when something is written on it, so one left empty is not kept.
 * Shared by the tree, the phone FAB and the desktop shortcut.
 */
export function usePageCreation(spaceId: string | null, token: string, openPage: (pageId: string) => void) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page the draft goes under once it is made.
  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const currentSpace = useRef(spaceId);
  useEffect(() => {
    currentSpace.current = spaceId;
    setError(null);
    setDraftParentId(null);
  }, [spaceId]);

  const create = useCallback((parentPageId: string | null) => {
    if (!spaceId) return;
    setError(null);
    setDraftParentId(parentPageId);
    openPage(NEW_PAGE_ID);
  }, [openPage, spaceId]);

  /**
   * Makes the draft into a page, and opens it when the draft is still what is open;
   * `opening` runs just before, for what the opened page should do first.
   */
  const persist = useCallback(async (input: { title: string; body?: string }, stillOpen: () => boolean,
    opening?: (pageId: string) => void) => {
    if (!spaceId || inFlight.current) return false;
    inFlight.current = true;
    setCreating(true);
    setError(null);
    try {
      const { page } = await pageApi.create(spaceId, token, { title: input.title, parentPageId: draftParentId,
        ...(input.body ? { body: input.body } : {}) });
      await queryClient.invalidateQueries({ queryKey: ["xmatrix"], predicate: (query) =>
        query.queryKey.includes("page-tree") });
      if (currentSpace.current === spaceId && stillOpen()) {
        opening?.(page.pageId);
        openPage(page.pageId);
      }
      return true;
    } catch (cause) {
      if (currentSpace.current === spaceId) {
        setError(userErrorMessage(cause, "Couldn't create the page"));
      }
      return false;
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }, [draftParentId, openPage, queryClient, spaceId, token]);
  return { create, persist, creating, error };
}

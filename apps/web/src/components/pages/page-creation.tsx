"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pageApi } from "@/lib/pages/page-client";
import { userErrorMessage } from "@/lib/user-facing-error";

export type PageCreation = ReturnType<typeof usePageCreation>;

/** What a new page is called until its author names it on the page itself. */
export const NEW_PAGE_TITLE = "Untitled";

/**
 * Like Notion: + makes an untitled page at once and opens it with its title ready to type over.
 * Shared by the tree, the phone FAB and the desktop shortcut.
 */
export function usePageCreation(spaceId: string | null, token: string, onCreated: (pageId: string) => void) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page just made here; it opens with its title focused.
  const [freshPageId, setFreshPageId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const currentSpace = useRef(spaceId);
  useEffect(() => {
    currentSpace.current = spaceId;
    setError(null);
    setFreshPageId(null);
  }, [spaceId]);

  const create = useCallback(async (parentPageId: string | null) => {
    if (!spaceId || inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError(null);
    try {
      const { page } = await pageApi.create(spaceId, token, { title: NEW_PAGE_TITLE, parentPageId });
      await queryClient.invalidateQueries({ queryKey: ["xmatrix"], predicate: (query) =>
        query.queryKey.includes("page-tree") });
      if (currentSpace.current === spaceId) {
        setFreshPageId(page.pageId);
        onCreated(page.pageId);
      }
    } catch (cause) {
      if (currentSpace.current === spaceId) {
        setError(userErrorMessage(cause, "Couldn't create the page"));
      }
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }, [onCreated, queryClient, spaceId, token]);
  return { create, creating, error, freshPageId };
}

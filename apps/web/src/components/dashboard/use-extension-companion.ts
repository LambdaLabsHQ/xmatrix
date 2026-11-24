"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  embedBrowserPage,
  isExtensionCompanion,
  subscribeEmbedBrowserPage,
  subscribeEmbedPage,
  subscribeEmbedRecent,
  type EmbedPage,
  type EmbedRecent,
} from "@/lib/extension-embed";

/** What the extension's side panel knows of the page beside it, and the conversations started from it. */
export type ExtensionCompanion = {
  /** The page in the active tab; null until the extension says, or on a page it cannot read. */
  page: EmbedPage | null;
  recent: EmbedRecent[];
};

/**
 * The side panel is a companion to the page beside it (Daniel 2026-11-23): the
 * conversation about that page and nothing else of the workspace. Null when
 * this app is not the extension's side panel.
 */
export function useExtensionCompanion(): ExtensionCompanion | null {
  const active = useMemo(() => isExtensionCompanion(), []);
  const [page, setPage] = useState<EmbedPage | null>(null);
  const [recent, setRecent] = useState<EmbedRecent[]>([]);
  useEffect(() => {
    if (!active) return;
    const stopPage = subscribeEmbedPage(setPage);
    const stopRecent = subscribeEmbedRecent(setRecent);
    return () => {
      stopPage();
      stopRecent();
    };
  }, [active]);
  return useMemo(() => (active ? { page, recent } : null), [active, page, recent]);
}

/**
 * The page that goes with what the person writes in the side panel (the composer's page chip): the page beside
 * it, until they take it off. Null outside the side panel.
 */
export function useEmbedBrowserPage(): { title: string; href: string } | null {
  return useSyncExternalStore(subscribeEmbedBrowserPage, embedBrowserPage, () => null);
}

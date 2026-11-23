"use client";

import { useEffect, useMemo, useState } from "react";
import { discussionHead } from "@xmatrix/protocol";
import {
  isExtensionCompanion,
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
 * What a question about the whole page opens holding: the page quoted by its
 * title, linked, as the App opens a discussion of a page the extension hands
 * it (handleWebPassage in use-workspace-shell-actions.ts).
 */
export function pageAskDraft(page: Pick<EmbedPage, "title" | "href">): string {
  const label = page.title.trim() || new URL(page.href).host;
  return discussionHead(label, { label, href: page.href });
}

/** The page's readable text, as the file "Ask about this page" attaches. */
export function pageTextFile(page: EmbedPage): File | null {
  if (!page.text?.trim()) return null;
  const name = `${(page.title || new URL(page.href).host).replace(/[\\/:*?"<>|\n]+/gu, " ").trim().slice(0, 80) || "page"}.md`;
  return new File([`# ${page.title}\n\n${page.href}\n\n${page.text}`], name, { type: "text/markdown" });
}

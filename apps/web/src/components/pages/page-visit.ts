"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pageApi } from "@/lib/pages/page-client";

/**
 * How far a person has read a page (pages-live-document.md §3.2): the newest version they have had open, kept
 * by the Hub on every device of theirs. Having the page on screen reads it. Coming to a page that moved past
 * what they had read, or back to its tab, what it became meanwhile is new to them for that visit: History's
 * button says so until they look, and History shows it first. What changes while they watch is not new.
 */
export function usePageVisit({ spaceId, pageId, token, headRevision, onScreen, onRead }: {
  spaceId: string | null; pageId: string | null; token: string; headRevision: number | null;
  /** The page's document is drawn. */
  onScreen: boolean;
  /** The page was read up to a version. */
  onRead: (pageId: string, revision: number) => void;
}): {
  /** The version they had last read as they came, while the page has moved past it; null when nothing is new. */
  since: number | null;
  /** Something is new and they have not looked at it yet. */
  fresh: boolean;
  /** They opened History: what is new has been looked at. */
  looked: () => void;
} {
  // How far the Hub had them as the page opened; unknown, nothing is read and nothing is new.
  const [read, setRead] = useState<{ pageId: string; revision: number | null } | null>(null);
  const [news, setNews] = useState<{ pageId: string; since: number; fresh: boolean } | null>(null);
  // The newest version they have had on screen in this visit, once they have come.
  const seen = useRef<{ pageId: string; revision: number } | null>(null);
  useEffect(() => {
    setRead(null);
    if (!spaceId || !pageId || !token) return;
    const controller = new AbortController();
    pageApi.readState(spaceId, pageId, token, controller.signal).then(({ revision }) => setRead({ pageId, revision }),
      () => undefined);
    return () => controller.abort();
  }, [spaceId, pageId, token]);
  useEffect(() => {
    if (!read || read.pageId !== pageId || headRevision === null || !spaceId || !onScreen) return;
    const see = (back: boolean) => {
      if (window.document.visibilityState !== "visible") return;
      const came = seen.current?.pageId === pageId;
      const last = came ? seen.current!.revision : read.revision;
      // Coming to the page, or back to its tab: what it became meanwhile is new. A first visit has nothing new.
      if ((!came || back) && last !== null && headRevision > last) setNews({ pageId, since: last, fresh: true });
      seen.current = { pageId, revision: Math.max(headRevision, last ?? 0) };
      if (last !== null && headRevision <= last) return;
      onRead(pageId, headRevision);
      void pageApi.markRead(spaceId, pageId, token, headRevision).catch(() => undefined);
    };
    see(false);
    const back = () => see(true);
    window.document.addEventListener("visibilitychange", back);
    return () => window.document.removeEventListener("visibilitychange", back);
  }, [headRevision, onRead, onScreen, pageId, read, spaceId, token]);
  const mine = news?.pageId === pageId ? news : null;
  const looked = useCallback(() => setNews((current) => current?.fresh ? { ...current, fresh: false } : current), []);
  return { since: mine?.since ?? null, fresh: mine?.fresh ?? false, looked };
}

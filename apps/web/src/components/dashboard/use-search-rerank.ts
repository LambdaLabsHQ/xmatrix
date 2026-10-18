"use client";

import { useEffect, useRef, useState } from "react";
import {
  SearchRerankUnavailable, type SearchRerankCandidate, type SearchRerankReading,
} from "./workspace-search-rank";

/** Asks Jev once the reader pauses, so typing does not spend a call per key. */
const RERANK_AFTER_MS = 300;
/** Past this the ranked results simply stay as they are. */
const DEADLINE_MS = 1_500;
const CACHE_LIMIT = 100;

export type WorkspaceSearchRerank = {
  spaceId: string;
  rerank: (query: string, candidates: readonly SearchRerankCandidate[], signal: AbortSignal) =>
    Promise<SearchRerankReading>;
};

const readings = new Map<string, SearchRerankReading>();
/** Spaces whose plan does not include Jev search; not asked again until reload. */
const unavailableSpaces = new Set<string>();

function remember(key: string, reading: SearchRerankReading): void {
  readings.delete(key);
  readings.set(key, reading);
  if (readings.size > CACHE_LIMIT) readings.delete(readings.keys().next().value!);
}

/**
 * Jev's reading of the current search, or null while there is none: before the
 * pause, while it is asked, after a failure or timeout, and in a Space not on Pro.
 */
export function useSearchRerank(rerank: WorkspaceSearchRerank | undefined, query: string,
  candidates: readonly SearchRerankCandidate[], enabled: boolean): SearchRerankReading | null {
  const text = query.trim();
  const active = enabled && !!rerank && !!text && candidates.length >= 2 && !unavailableSpaces.has(rerank.spaceId);
  const key = active ? JSON.stringify([rerank.spaceId, text.toLocaleLowerCase(),
    candidates.map((candidate) => [candidate.key, candidate.title])]) : "";
  const [current, setCurrent] = useState<{ key: string; reading: SearchRerankReading } | null>(null);
  const latest = useRef({ rerank, text, candidates });
  latest.current = { rerank, text, candidates };

  useEffect(() => {
    if (!key) return;
    const cached = readings.get(key);
    if (cached) {
      setCurrent({ key, reading: cached });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const { rerank: ask, text: asked, candidates: shown } = latest.current;
      if (!ask) return;
      const deadline = window.setTimeout(() => controller.abort(), DEADLINE_MS);
      void ask.rerank(asked, shown, controller.signal).then((reading) => {
        remember(key, reading);
        if (!controller.signal.aborted) setCurrent({ key, reading });
      }, (error: unknown) => {
        if (error instanceof SearchRerankUnavailable) unavailableSpaces.add(ask.spaceId);
      }).finally(() => window.clearTimeout(deadline));
    }, RERANK_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return key && current?.key === key ? current.reading : (key ? readings.get(key) ?? null : null);
}

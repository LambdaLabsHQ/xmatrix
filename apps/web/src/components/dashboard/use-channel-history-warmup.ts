import type { SerializedChannel } from "@xmatrix/protocol";
import { useEffect, useRef, type RefObject } from "react";
import { sortChannelHistory } from "./channel-history";
import {
  HISTORY_WARMUP_CONCURRENCY,
  HISTORY_WARMUP_DELAY_MS,
  channelsToWarmHistory,
} from "./channel-history-warmup";
import { fetchChannelHistory } from "./workspace-admin-views";
import { INITIAL_HISTORY_LIMIT } from "./workspace-shell-constants";
import type { ChannelHistoryCacheEntry } from "./workspace-shell-helpers";
import { compactChannelHistoryCacheInPlace } from "./workspace-shell-helpers-extra";

/**
 * Opening a Channel the reader has not visited this session costs a full Hub
 * round trip behind a skeleton. Once startup has settled, read the latest page
 * of the Space's first Channels into the in-memory history cache so the next
 * open paints from it and refreshes in the background, exactly like a revisit.
 * Each read is an ordinary authorized Hub read; nothing here grants render
 * authority on its own.
 */
export function useChannelHistoryWarmup(input: {
  token: string | undefined;
  /** Signed in and past the startup critical path. */
  ready: boolean;
  spaceId: string | null;
  channels: readonly SerializedChannel[];
  selectedChannelId: string | null;
  selectedChannelIdRef: RefObject<string | null>;
  historyCacheRef: RefObject<Map<string, ChannelHistoryCacheEntry>>;
}): void {
  const { token, ready, spaceId, channels, selectedChannelId, selectedChannelIdRef, historyCacheRef } = input;
  const queueRef = useRef<{
    token: string;
    controller: AbortController;
    attempts: Map<string, number>;
    next: () => string | undefined;
    timer?: ReturnType<typeof setTimeout>;
    lanes: number;
  } | null>(null);
  useEffect(() => {
    if (!token) return;
    const queue: NonNullable<typeof queueRef.current> = {
      token, controller: new AbortController(), attempts: new Map(), next: () => undefined, lanes: 0,
    };
    queueRef.current = queue;
    return () => {
      queue.controller.abort();
      clearTimeout(queue.timer);
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [token]);
  useEffect(() => {
    const queue = queueRef.current;
    if (!queue || queue.token !== token) return;
    // Pick from current state when a lane is free. A copied queue can outlive
    // a Space switch or an interactive read that has already filled the cache.
    queue.next = () => ready && spaceId ? channelsToWarmHistory({
      channels, spaceId,
      selectedChannelId: selectedChannelIdRef.current,
      hasCachedHistory: (id) => historyCacheRef.current.has(id),
      lastAttemptAt: (id) => queue.attempts.get(id),
      now: Date.now(),
    })[0] : undefined;
    const { signal } = queue.controller;
    const readLane = async (): Promise<void> => {
      queue.lanes += 1;
      try {
        for (let channelId = queue.next(); channelId && !signal.aborted; channelId = queue.next()) {
          queue.attempts.set(channelId, Date.now());
          try {
            const page = await fetchChannelHistory(queue.token, channelId, {
              limit: INITIAL_HISTORY_LIMIT,
              signal,
            });
            // An open or a revisit that landed meanwhile owns the cache.
            if (signal.aborted || page.messages.length === 0 ||
                selectedChannelIdRef.current === channelId ||
                historyCacheRef.current.has(channelId)) continue;
            historyCacheRef.current.set(channelId, {
              messages: sortChannelHistory(page.messages),
              hasOlderMessages: page.hasMore,
              cachedAt: Date.now(),
            });
            compactChannelHistoryCacheInPlace(historyCacheRef.current);
          } catch {
            // Speculative: a failed warm-up leaves the ordinary open path unchanged.
          }
        }
      } finally {
        queue.lanes -= 1;
      }
    };
    // Catalog churn updates selection without restarting reads already in flight.
    if (queue.timer !== undefined || !queue.next()) return;
    queue.timer = setTimeout(() => {
      queue.timer = undefined;
      while (!signal.aborted && queue.lanes < HISTORY_WARMUP_CONCURRENCY && queue.next()) {
        void readLane();
      }
    }, HISTORY_WARMUP_DELAY_MS);
  }, [channels, historyCacheRef, ready, selectedChannelId, selectedChannelIdRef, spaceId, token]);
}

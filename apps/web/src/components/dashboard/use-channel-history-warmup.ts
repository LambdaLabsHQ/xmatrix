import type { SerializedChannel } from "@xmatrix/protocol";
import { useEffect, useRef, type RefObject } from "react";
import { sortChannelHistory } from "./channel-history";
import {
  HISTORY_WARMUP_CONCURRENCY,
  HISTORY_WARMUP_DELAY_MS,
  channelsToWarmHistory,
  newestSequence,
  warmedHistoryWindow,
} from "./channel-history-warmup";
import { fetchChannelHistory } from "./workspace-admin-views";
import { INITIAL_HISTORY_LIMIT } from "./workspace-shell-constants";
import { compactChannelHistoryCacheInPlace } from "./workspace-shell-helpers-extra";
import { useStableCallback, type ChannelHistoryCacheEntry } from "./workspace-shell-helpers";

/**
 * Opening a Channel the reader has not visited this session costs a full Hub
 * round trip behind a skeleton. Once startup has settled, read the latest page
 * of the Space's first Channels into the in-memory history cache so the next
 * open paints from it and refreshes in the background, exactly like a revisit.
 * When the live socket comes back after a drop, the windows it may have missed
 * messages for are read again the same way, so the next open paints current
 * rows rather than the ones from before the drop. Each read is an ordinary
 * authorized Hub read; nothing here grants render authority on its own.
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
  /** Changes each time the live socket connects; a new connection may leave windows behind. */
  socketGeneration: number;
  /** The live socket is up; while it is down no window can be shown current. */
  socketLive: () => boolean;
  /** The live socket has delivered every message since this Channel's window was read. */
  historyTailContiguous: (channelId: string) => boolean;
  /** Starts a read; what it returns marks the Channel's window as read then, if the socket held meanwhile. */
  beginHistoryTailRead: () => (channelId: string) => void;
}): void {
  const {
    token, ready, spaceId, channels, selectedChannelId, selectedChannelIdRef, historyCacheRef,
    socketGeneration,
  } = input;
  const socketLive = useStableCallback(input.socketLive);
  const historyTailContiguous = useStableCallback(input.historyTailContiguous);
  const beginHistoryTailRead = useStableCallback(input.beginHistoryTailRead);
  const queueRef = useRef<{
    token: string;
    controller: AbortController;
    /** Each Channel's last read: when, for which head, and on which socket connection. */
    attempts: Map<string, { at: number; head: number; socketGeneration: number; read: boolean }>;
    next: () => string | undefined;
    /** What a read started now is for: the Channel's listed head, and the socket connection. */
    readFor: (channelId: string) => { head: number; socketGeneration: number };
    timer?: ReturnType<typeof setTimeout>;
    lanes: number;
  } | null>(null);
  useEffect(() => {
    if (!token) return;
    const queue: NonNullable<typeof queueRef.current> = {
      token, controller: new AbortController(), attempts: new Map(), next: () => undefined,
      readFor: () => ({ head: 0, socketGeneration: 0 }), lanes: 0,
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
      hasCurrentHistory: (id, head) => {
        const cached = historyCacheRef.current.get(id);
        if (!cached || newestSequence(cached.messages) < head) return false;
        // Read again once the socket is back, not while it cannot prove anything.
        return !socketLive() || historyTailContiguous(id);
      },
      lastAttemptAt: (id, head) => {
        const attempt = queue.attempts.get(id);
        // A head past the one read, or a connection since, is another read. One
        // that succeeded is not repeated: a head the page cannot reach (rows
        // this reader is not shown) must not be read again and again.
        if (!attempt || attempt.head < head || attempt.socketGeneration !== socketGeneration) return undefined;
        return attempt.read ? Number.POSITIVE_INFINITY : attempt.at;
      },
      now: Date.now(),
    })[0] : undefined;
    queue.readFor = (id) => {
      const listed = channels.find((channel) => channel.id === id);
      return { head: listed?.historyHeadSequence ?? listed?.messageCount ?? 0, socketGeneration };
    };
    const { signal } = queue.controller;
    const readLane = async (): Promise<void> => {
      queue.lanes += 1;
      try {
        for (let channelId = queue.next(); channelId && !signal.aborted; channelId = queue.next()) {
          const attempt = { at: Date.now(), ...queue.readFor(channelId), read: false };
          queue.attempts.set(channelId, attempt);
          const markRead = beginHistoryTailRead();
          try {
            const page = await fetchChannelHistory(queue.token, channelId, {
              limit: INITIAL_HISTORY_LIMIT,
              signal,
            });
            attempt.read = true;
            // An open that landed meanwhile owns the cache, and so does a
            // window that already reaches this page and has missed nothing.
            const held = historyCacheRef.current.get(channelId)?.messages ?? [];
            if (signal.aborted || page.messages.length === 0 ||
                selectedChannelIdRef.current === channelId ||
                (newestSequence(held) >= newestSequence(page.messages) && historyTailContiguous(channelId))) continue;
            historyCacheRef.current.set(channelId, {
              // Live messages merged into the held window during the read stay.
              messages: sortChannelHistory(warmedHistoryWindow(page.messages, held)),
              hasOlderMessages: page.hasMore,
              cachedAt: Date.now(),
            });
            markRead(channelId);
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
  }, [beginHistoryTailRead, channels, historyCacheRef, historyTailContiguous, ready, selectedChannelId,
    selectedChannelIdRef, socketGeneration, socketLive, spaceId, token]);
}

"use client";

import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChannelMessage, SerializedChannel } from "@xmatrix/protocol";
import { INITIAL_HISTORY_LIMIT } from "./workspace-shell-constants";
import { fetchChannelHistory } from "./workspace-admin-views";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

type Input = {
  token: string | undefined;
  selectedChannelIdRef: MutableRefObject<string | null>;
  historyChannelIdRef: MutableRefObject<string | null>;
  channelsRef: MutableRefObject<SerializedChannel[]>;
  applyHistory(channelId: string, messages: ChannelMessage[], hasOlderMessages: boolean): void;
  recordTailBase(channelId: string): void;
  authorizeOnlineHistory(channelId: string): void;
  setHistoryError(error: string | null): void;
  setLoadingHistory(loading: boolean): void;
};

export type HumanFocusHistoryHttpFallback = {
  recoverFromSocketError(requestId: string | undefined, error: string): boolean;
  recoverFromSocketPage(input: {
    channelId: string;
    hasMore: boolean;
    receivedMessages: ChannelMessage[];
    rawMessageCount: number;
  }): boolean;
};

/**
 * Human focus history prefers the live socket, but a socket failure must not
 * strand a sparse realtime tail. Recovering through the
 * ordinary authenticated history endpoint preserves the same ACL and keyset
 * pagination contract while keeping the failure path bounded to one request.
 */
export function useHumanFocusHistoryHttpFallback(input: Input): HumanFocusHistoryHttpFallback {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef(input);
  inputRef.current = input;

  const isFocused = useCallback((channelId: string): boolean => {
    const current = inputRef.current;
    return current.selectedChannelIdRef.current === channelId &&
      current.historyChannelIdRef.current === channelId;
  }, []);

  const recover = useCallback((channelId: string, socketFailure: string): void => {
    const current = inputRef.current;
    const token = current.token;
    if (!token || !isFocused(channelId)) return;
    void (async () => {
      try {
        const knownHead = current.channelsRef.current.find((item) => item.id === channelId)
          ?.historyHeadSequence ?? 0;
        const onlinePage = await queryClient.fetchQuery({
          queryKey: xmatrixQueryKeys.domain(
            { userId: user?.id ?? "anonymous" },
            "message-history-fallback",
            [channelId, knownHead, INITIAL_HISTORY_LIMIT],
          ),
          queryFn: ({ signal }) => fetchChannelHistory(token, channelId, {
            limit: INITIAL_HISTORY_LIMIT, signal,
          }),
          staleTime: 1_000,
        });
        if (!isFocused(channelId)) return;
        const next = inputRef.current;
        next.applyHistory(
          channelId,
          onlinePage.messages,
          onlinePage.hasMore,
        );
        next.recordTailBase(channelId);
        next.authorizeOnlineHistory(channelId);
        next.setHistoryError(null);
        next.setLoadingHistory(false);
      } catch {
        if (!isFocused(channelId)) return;
        const next = inputRef.current;
        next.setHistoryError(socketFailure);
        next.setLoadingHistory(false);
      }
    })();
  }, [isFocused, queryClient, user?.id]);

  return useMemo(() => ({
    recoverFromSocketError(requestId, error) {
      const prefix = "focus-history:";
      if (!requestId?.startsWith(prefix)) return false;
      const channelId = requestId.slice(prefix.length);
      if (!channelId || !isFocused(channelId)) return false;
      recover(channelId, error);
      return true;
    },
    recoverFromSocketPage({ channelId, hasMore, receivedMessages, rawMessageCount }) {
      if (!isFocused(channelId)) return false;
      const highestSequence = receivedMessages.reduce((highest, entry) =>
        typeof entry.sequence === "number" && Number.isSafeInteger(entry.sequence)
          ? Math.max(highest, entry.sequence)
          : highest,
      0);
      const channel = inputRef.current.channelsRef.current.find((item) => item.id === channelId);
      const incomplete =
        receivedMessages.length !== rawMessageCount ||
        (hasMore && receivedMessages.length < INITIAL_HISTORY_LIMIT) ||
        (channel?.historyHeadSequence !== undefined && highestSequence < channel.historyHeadSequence);
      if (!incomplete) return false;
      recover(channelId, "The live Channel history page was incomplete; retrying over HTTP.");
      return true;
    },
  }), [isFocused, recover]);
}

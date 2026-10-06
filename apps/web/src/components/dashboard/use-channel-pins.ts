"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { readPins, savePin, type PinRecord } from "./channel-pins-client";
import type { ChannelPinState } from "./workspace-shell-helpers";

/** A person's pinned conversations in one Space, listed first. */
export function useChannelPins(input: { token?: string; userId?: string; spaceId: string | null }) {
  const client = useQueryClient();
  const key = useMemo(
    () => xmatrixQueryKeys.preference({ userId: input.userId || "anonymous", spaceId: input.spaceId || "none" }),
    [input.spaceId, input.userId],
  );
  const enabled = Boolean(input.token && input.userId && input.spaceId);
  const pins = useQuery({
    queryKey: key,
    queryFn: () => readPins({ token: input.token!, spaceId: input.spaceId! }),
    enabled,
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (change: { channelId: string; pinned: boolean }) =>
      savePin({ token: input.token!, spaceId: input.spaceId!, change }),
    onMutate: ({ channelId, pinned }) => {
      const current = client.getQueryData<PinRecord>(key) ?? { pinnedChannelIds: [], version: 0 };
      const rest = current.pinnedChannelIds.filter((id) => id !== channelId);
      client.setQueryData<PinRecord>(key, { ...current, pinnedChannelIds: pinned ? [channelId, ...rest] : rest });
    },
    // Pins lead the Channel list, so its order is re-read along with them.
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: key, exact: true }),
      client.invalidateQueries({
        queryKey: xmatrixQueryKeys.channels({ userId: input.userId || "anonymous", spaceId: input.spaceId || "none" }),
      }),
    ]),
  });
  const mutatePin = mutation.mutate;
  const toggleChannelPinned = useCallback((channelId: string) => {
    if (!enabled) return;
    const pinned = client.getQueryData<PinRecord>(key)?.pinnedChannelIds.includes(channelId) ?? false;
    mutatePin({ channelId, pinned: !pinned });
  }, [client, enabled, key, mutatePin]);
  const pinnedChannelIds = pins.data?.pinnedChannelIds;
  const channelPinState: ChannelPinState = useMemo(() => {
    const ids = pinnedChannelIds ?? [];
    return { pinnedChannelIds: ids, orderedChannelIds: ids };
  }, [pinnedChannelIds]);
  return { channelPinState, toggleChannelPinned };
}

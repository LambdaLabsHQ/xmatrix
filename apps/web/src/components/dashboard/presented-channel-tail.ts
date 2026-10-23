"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ChannelSnapshot } from "@xmatrix/protocol";
import { sameValue } from "../../lib/same-value";

type Preview = NonNullable<ChannelSnapshot["lastMessage"]>;

/** The newest message the open conversation's timeline shows, as its list row previews it. */
export type PresentedChannelTail = { channelId: string; sequence: number; preview: Preview };

/**
 * The Channel as its list row shows it. While its conversation is open, the
 * row's last message and count are the timeline's newest message, read the
 * same way the timeline reads it: one source for both, so the list never shows
 * a message the conversation does not (a Channel snapshot from a presence
 * report or a catalog read can name a newer one before its message arrives).
 */
export function channelAsTimelineShows(
  channel: ChannelSnapshot,
  tail: PresentedChannelTail | null | undefined,
): ChannelSnapshot {
  if (!tail || tail.channelId !== channel.id) return channel;
  const messageCount = tail.sequence > 0 ? tail.sequence : channel.messageCount;
  if (sameValue(channel.lastMessage, tail.preview) && messageCount === channel.messageCount) return channel;
  return { ...channel, lastMessage: tail.preview, messageCount };
}

/** One value and its listeners; a row hears only a change to its own Channel. */
export function createPresentedChannelTail() {
  let current: PresentedChannelTail | null = null;
  const listeners = new Map<string, Set<() => void>>();
  const notify = (channelId: string | undefined) => {
    if (channelId) for (const listener of listeners.get(channelId) ?? []) listener();
  };
  return {
    get: (channelId: string) => (current?.channelId === channelId ? current : null),
    set(next: PresentedChannelTail | null) {
      if (sameValue(current, next)) return;
      const previous = current?.channelId;
      current = next;
      notify(previous);
      if (next?.channelId !== previous) notify(next?.channelId);
    },
    subscribe(channelId: string, listener: () => void) {
      let set = listeners.get(channelId);
      if (!set) listeners.set(channelId, set = new Set());
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (!set!.size) listeners.delete(channelId);
      };
    },
  };
}

export type PresentedChannelTailStore = ReturnType<typeof createPresentedChannelTail>;

export const PresentedChannelTailContext = createContext<PresentedChannelTailStore | null>(null);

const noSubscription = () => () => {};

/** The open timeline's newest message when `channelId` is the open conversation. */
export function usePresentedChannelTail(channelId: string): PresentedChannelTail | null {
  const store = useContext(PresentedChannelTailContext);
  const subscribe = useCallback((notify: () => void) => store?.subscribe(channelId, notify) ?? noSubscription(),
    [store, channelId]);
  const snapshot = useCallback(() => store?.get(channelId) ?? null, [store, channelId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** `channel` as its row shows it (channelAsTimelineShows); the same object while the two agree. */
export function useChannelAsTimelineShows(channel: ChannelSnapshot): ChannelSnapshot {
  const tail = usePresentedChannelTail(channel.id);
  return useMemo(() => channelAsTimelineShows(channel, tail), [channel, tail]);
}

"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { SerializedChannel } from "@xmatrix/protocol";
import { time } from "./channel-message-summary";

type Preview = NonNullable<SerializedChannel["lastMessage"]>;

/** The newest message the open conversation's timeline shows, as its list row previews it. */
export type PresentedChannelTail = { channelId: string; sequence: number; preview: Preview };

/**
 * The Channel as its list row shows it: never ahead of its open timeline.
 *
 * A Channel snapshot (a presence report, a catalog read) can name a newer last
 * message than the timeline has received, and the list used to show it, and
 * count it unread, first. The row keeps the newest message the timeline shows,
 * and counts no message past it, until the timeline has the newer one too, so
 * both show it in the same frame.
 */
export function channelNotAheadOfTimeline(
  channel: SerializedChannel,
  tail: PresentedChannelTail | null | undefined,
): SerializedChannel {
  if (!tail || tail.channelId !== channel.id) return channel;
  const listed = channel.lastMessage;
  const previewAhead = Boolean(listed && listed.messageId !== tail.preview.messageId &&
    time(listed.sentAt) > time(tail.preview.sentAt));
  const countAhead = tail.sequence > 0 && (channel.messageCount ?? 0) > tail.sequence;
  if (!previewAhead && !countAhead) return channel;
  return {
    ...channel,
    ...(previewAhead ? { lastMessage: tail.preview } : {}),
    ...(countAhead ? { messageCount: tail.sequence } : {}),
  };
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
      if (current === next || (current && next && current.channelId === next.channelId &&
          current.sequence === next.sequence && current.preview.messageId === next.preview.messageId && current.preview.sentAt === next.preview.sentAt &&
          current.preview.bodyPreview === next.preview.bodyPreview &&
          current.preview.recalledAt === next.preview.recalledAt)) return;
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

/** `channel` as its row shows it (channelNotAheadOfTimeline); the same object while nothing is held back. */
export function useChannelNotAheadOfTimeline(channel: SerializedChannel): SerializedChannel {
  const tail = usePresentedChannelTail(channel.id);
  return useMemo(() => channelNotAheadOfTimeline(channel, tail), [channel, tail]);
}

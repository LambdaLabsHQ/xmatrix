"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ObservabilityEvent, ChannelSnapshot } from "@xmatrix/protocol";
import type { RealtimeCollection } from "./realtime-collection";

export const RealtimeChannelsContext = createContext<RealtimeCollection<ChannelSnapshot> | null>(null);
export type ChannelEventView = { id: string; events: readonly ObservabilityEvent[] };
export const RealtimeEventsContext = createContext<RealtimeCollection<ChannelEventView> | null>(null);

const noSubscription = () => () => {};
const wholeChannel = (channel: ChannelSnapshot | null) => channel;

function useRealtimeChannelSnapshot<T>(channel: ChannelSnapshot | null, id: string,
  source: RealtimeCollection<ChannelSnapshot> | undefined, select: (channel: ChannelSnapshot | null) => T) {
  const context = useContext(RealtimeChannelsContext);
  const store = source ?? context;
  const subscribe = useCallback((notify: () => void) => store?.subscribeKey(id, notify) ?? noSubscription(), [store, id]);
  const snapshot = useCallback(() => select(store?.get(id) ?? channel), [store, id, channel, select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A mounted row subscribes to its Channel, including reports that reach it
 * under an Instance id rather than the catalog's member id. */
export function useRealtimeChannel(channel: ChannelSnapshot | null, id = channel?.id ?? "",
  source?: RealtimeCollection<ChannelSnapshot>) {
  return useRealtimeChannelSnapshot(channel, id, source, wholeChannel);
}

/** Primitive selections stay stable when unrelated live fields change. */
export function useRealtimeChannelValue<T extends string | number | boolean | null | undefined>(
  channel: ChannelSnapshot | null, select: (channel: ChannelSnapshot | null) => T,
  source?: RealtimeCollection<ChannelSnapshot>,
) {
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

/** select must return the same reference for unchanged presentation, including
 * repeated snapshot reads. Keep its cache scoped to this Channel and inputs. */
export function useRealtimeChannelSelection<T>(
  channel: ChannelSnapshot | null, select: (channel: ChannelSnapshot | null) => T,
  source?: RealtimeCollection<ChannelSnapshot>,
) {
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

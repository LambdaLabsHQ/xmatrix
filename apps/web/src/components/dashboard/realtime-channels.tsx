"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ObservabilityEvent, SerializedChannel } from "@xmatrix/protocol";
import type { RealtimeCollection } from "./realtime-collection";

export const RealtimeChannelsContext = createContext<RealtimeCollection<SerializedChannel> | null>(null);
export type ChannelEventView = { id: string; events: readonly ObservabilityEvent[] };
export const RealtimeEventsContext = createContext<RealtimeCollection<ChannelEventView> | null>(null);

const noSubscription = () => () => {};
const wholeChannel = (channel: SerializedChannel | null) => channel;

function useRealtimeChannelSnapshot<T>(channel: SerializedChannel | null, id: string,
  source: RealtimeCollection<SerializedChannel> | undefined, select: (channel: SerializedChannel | null) => T) {
  const context = useContext(RealtimeChannelsContext);
  const store = source ?? context;
  const subscribe = useCallback((notify: () => void) => store?.subscribeKey(id, notify) ?? noSubscription(), [store, id]);
  const snapshot = useCallback(() => select(store?.get(id) ?? channel), [store, id, channel, select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A mounted row subscribes to its Channel, including reports that reach it
 * under an Instance id rather than the catalog's member id. */
export function useRealtimeChannel(channel: SerializedChannel | null, id = channel?.id ?? "",
  source?: RealtimeCollection<SerializedChannel>) {
  return useRealtimeChannelSnapshot(channel, id, source, wholeChannel);
}

/** Primitive selections stay stable when unrelated live fields change. */
export function useRealtimeChannelValue<T extends string | number | boolean | null | undefined>(
  channel: SerializedChannel | null, select: (channel: SerializedChannel | null) => T,
  source?: RealtimeCollection<SerializedChannel>,
) {
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

/** select must return the same reference for unchanged presentation, including
 * repeated snapshot reads. Keep its cache scoped to this Channel and inputs. */
export function useRealtimeChannelSelection<T>(
  channel: SerializedChannel | null, select: (channel: SerializedChannel | null) => T,
  source?: RealtimeCollection<SerializedChannel>,
) {
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

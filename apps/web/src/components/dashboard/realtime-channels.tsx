"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ObservabilityEvent, SerializedChannel } from "@xmatrix/protocol";
import type { RealtimeCollection } from "./realtime-collection";

export const RealtimeChannelsContext = createContext<RealtimeCollection<SerializedChannel> | null>(null);
export type ChannelEventView = { id: string; events: readonly ObservabilityEvent[] };
export const RealtimeEventsContext = createContext<RealtimeCollection<ChannelEventView> | null>(null);

const noSubscription = () => () => {};

/** A mounted row subscribes to its Channel, including reports that reach it
 * under an Instance id rather than the catalog's member id. */
export function useRealtimeChannel(channel: SerializedChannel | null, id = channel?.id ?? "",
  source?: RealtimeCollection<SerializedChannel>) {
  const context = useContext(RealtimeChannelsContext);
  const store = source ?? context;
  const subscribe = useCallback((notify: () => void) => store?.subscribeKey(id, notify) ?? noSubscription(), [store, id]);
  const snapshot = useCallback(() => store?.get(id) ?? channel, [store, id, channel]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

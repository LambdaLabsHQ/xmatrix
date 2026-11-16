"use client";

import { useCallback, useContext, useSyncExternalStore, type ComponentProps } from "react";
import { presenceInstanceId } from "@xmatrix/protocol";
import { Face } from "./face";
import { RealtimeChannelsContext, RealtimeEventsContext } from "./realtime-channels";
import { agentInstanceDisplayStatus } from "./workspace-shell-presence";

const noEvents = [] as const;

/** Every visible sender affordance reads one primitive status from the live
 * Instance store. Message history contains identity, never a status copy. */
export function useMessageSenderStatus({ channelId, instanceId, senderId, name, fallbackStatus }: {
  channelId?: string; instanceId?: string; senderId?: string; name: string; fallbackStatus?: string;
}) {
  const store = useContext(RealtimeChannelsContext);
  const events = useContext(RealtimeEventsContext);
  const subscribe = useCallback((notify: () => void) => {
    const unlisten = store && channelId && (instanceId || senderId) ? store.subscribeKey(channelId, notify) : () => {};
    const own = channelId ? events?.subscribeKey(channelId, notify) : undefined;
    const global = events?.subscribeKey("", notify);
    return () => { unlisten(); own?.(); global?.(); };
  }, [store, events, channelId, instanceId, senderId]);
  const snapshot = useCallback(() => {
    const channel = channelId ? store?.get(channelId) : undefined;
    if (!channel) return store ? undefined : fallbackStatus;
    if (!instanceId) {
      const presence = senderId ? channel.presence?.humans.get(senderId) : undefined;
      return presence?.status;
    }
    const instance = channel.presence?.instances.get(presenceInstanceId(instanceId));
    return instance ? agentInstanceDisplayStatus({ instance, agentId: senderId,
      events: events?.get(channelId ?? "")?.events ?? events?.get("")?.events ?? noEvents, name }) : undefined;
  }, [store, events, channelId, instanceId, senderId, fallbackStatus, name]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function RealtimeMessageAvatar({ channelId, instanceId, senderId, ...props }: ComponentProps<typeof Face> & {
  channelId?: string; instanceId?: string; senderId?: string;
}) {
  const status = useMessageSenderStatus({ channelId, instanceId, senderId, name: props.of.name, fallbackStatus: props.status });
  return <Face {...props} status={status} />;
}

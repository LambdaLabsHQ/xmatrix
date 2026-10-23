"use client";

import { useCallback, useContext, useSyncExternalStore, type ComponentProps } from "react";
import { presenceInstanceId } from "@xmatrix/protocol";
import { Face } from "./face";
import { RealtimeChannelsContext, RealtimeEventsContext } from "./realtime-channels";
import { agentInstanceDisplayStatus } from "./workspace-shell-presence";

const noEvents = [] as const;

/** Only the avatar's visible status subscribes to live state. Activity is
 * read when its trace is opened, so Markdown rows never depend on it. */
export function RealtimeMessageAvatar({ channelId, instanceId, senderId, ...props }: ComponentProps<typeof Face> & {
  channelId?: string;
  instanceId?: string;
  senderId?: string;
}) {
  const store = useContext(RealtimeChannelsContext);
  const events = useContext(RealtimeEventsContext);
  const subscribe = useCallback((notify: () => void) => {
    const unlisten = store && channelId && (instanceId || senderId) ? store.subscribeKey(channelId, notify) : () => {};
    const own = channelId ? events?.subscribeKey(channelId, notify) : undefined;
    const global = events?.subscribeKey("", notify);
    return () => { unlisten(); own?.(); global?.(); };
  }, [store, events, channelId, instanceId, senderId]);
  const name = props.of.name;
  const snapshot = useCallback(() => {
    const channel = channelId ? store?.get(channelId) : undefined;
    if (!channel) return props.status;
    if (!instanceId) {
      const presence = senderId ? channel.presence?.humans.get(senderId) : undefined;
      return presence?.status ?? props.status;
    }
    const instance = channel.presence?.instances.get(presenceInstanceId(instanceId));
    return instance
      ? agentInstanceDisplayStatus({ instance, agentId: senderId,
        events: events?.get(channelId ?? "")?.events ?? events?.get("")?.events ?? noEvents, name })
      : props.status === undefined ? undefined : "offline";
  }, [store, events, channelId, instanceId, senderId, props.status, name]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <Face {...props} status={status} />;
}

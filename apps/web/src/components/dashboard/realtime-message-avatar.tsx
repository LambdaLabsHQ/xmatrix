"use client";

import { useCallback, useContext, useSyncExternalStore, type ComponentProps } from "react";
import { channelAgentInstanceIndex, type SerializedChannel } from "@xmatrix/protocol";
import { IdentityAvatar } from "./identity-avatar";
import { RealtimeChannelsContext, RealtimeEventsContext } from "./realtime-channels";
import { agentInstanceDisplayStatus } from "./workspace-shell-presence";

const instances = new WeakMap<SerializedChannel, ReturnType<typeof channelAgentInstanceIndex>>();
const noEvents = [] as const;

/** Only the avatar's visible status subscribes to live state. Activity is
 * read when its trace is opened, so Markdown rows never depend on it. */
export function RealtimeMessageAvatar({ channelId, instanceId, senderId, ...props }: ComponentProps<typeof IdentityAvatar> & {
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
  const snapshot = useCallback(() => {
    const channel = channelId ? store?.get(channelId) : undefined;
    if (!channel) return props.status;
    if (!instanceId) {
      const presence = senderId ? channel.memberPresence?.[senderId] : undefined;
      return presence?.kind === "user" ? presence.status ?? props.status : props.status;
    }
    let index = instances.get(channel);
    if (!index) {
      index = channelAgentInstanceIndex(channel);
      instances.set(channel, index);
    }
    const instance = index.get(instanceId)?.instance;
    return instance
      ? agentInstanceDisplayStatus({ instance, agentId: senderId,
        events: events?.get(channelId ?? "")?.events ?? events?.get("")?.events ?? noEvents, name: props.label })
      : props.status === undefined ? undefined : "offline";
  }, [store, events, channelId, instanceId, senderId, props.status, props.label]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <IdentityAvatar {...props} status={status} />;
}

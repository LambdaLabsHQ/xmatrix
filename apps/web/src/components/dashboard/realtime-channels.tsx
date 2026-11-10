"use client";

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { sameValue, type AgentInstancePresence, type ObservabilityEvent, type ChannelSnapshot, type LiveChannel,
  type PresenceInstanceId } from "@xmatrix/protocol";
import type { RealtimeCollection } from "./realtime-collection";

/** What a live read needs: each Channel as it stands now, its Instances included. */
export type LiveChannelSource = Pick<RealtimeCollection<LiveChannel>, "get" | "subscribeKey">;
export const RealtimeChannelsContext = createContext<LiveChannelSource | null>(null);
export type ChannelEventView = { id: string; events: readonly ObservabilityEvent[] };
export const RealtimeEventsContext = createContext<RealtimeCollection<ChannelEventView> | null>(null);

const noSubscription = () => () => {};
const wholeChannel = (channel: LiveChannel | null) => channel;

const unplacedViews = new WeakMap<ChannelSnapshot, LiveChannel>();
/** A list copy the live store does not hold: none of its Instances is known here. */
function withoutInstances(channel: ChannelSnapshot): LiveChannel {
  let view = unplacedViews.get(channel);
  if (!view) {
    view = { ...channel, presence: channel.presence ? { ...channel.presence, instances: new Map() } : undefined };
    unplacedViews.set(channel, view);
  }
  return view;
}

function useRealtimeChannelSnapshot<T>(channel: ChannelSnapshot | null, id: string,
  source: LiveChannelSource | undefined, select: (channel: LiveChannel | null) => T) {
  const context = useContext(RealtimeChannelsContext);
  const store = source ?? context;
  const subscribe = useCallback((notify: () => void) => store?.subscribeKey(id, notify) ?? noSubscription(), [store, id]);
  const snapshot = useCallback(() => select(store?.get(id) ?? (channel && withoutInstances(channel))),
    [store, id, channel, select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A mounted row subscribes to its Channel, including reports that reach it
 * under an Instance id rather than the catalog's member id. */
export function useRealtimeChannel(channel: ChannelSnapshot | null, id = channel?.id ?? "",
  source?: LiveChannelSource) {
  return useRealtimeChannelSnapshot(channel, id, source, wholeChannel);
}

/** Primitive selections stay stable when unrelated live fields change. */
export function useRealtimeChannelValue<T extends string | number | boolean | null | undefined>(
  channel: ChannelSnapshot | null, select: (channel: LiveChannel | null) => T,
  source?: LiveChannelSource,
) {
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

/** select must return the same reference for unchanged presentation, including
 * repeated snapshot reads. Keep its cache scoped to this Channel and inputs. */
export function useRealtimeChannelSelection<T>(
  channel: ChannelSnapshot | null, select: (channel: LiveChannel | null) => T,
  source?: LiveChannelSource,
) {
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

/** Who an Instance is and where it runs, without what it is doing now. Only
 * going offline changes its status here; busy and idle read as online. */
function instanceIdentity(instance: AgentInstancePresence): AgentInstancePresence {
  const { id, channelId, channelInstanceId, label, agentName, registration, email, connectedAt, rest,
    offlineReason, hostName, hostId, hostname, machineId, cwd, workspaceName, repository } = instance;
  return { id, channelId, channelInstanceId, label, agentName, registration, email, connectedAt, rest, offlineReason,
    hostName, hostId, hostname, machineId, cwd, workspaceName, repository,
    lastSeenAt: connectedAt, status: instance.status === "offline" ? "offline" : "online" };
}

type IdentityView = { channel: ChannelSnapshot; instances: ReadonlyMap<PresenceInstanceId, AgentInstancePresence>;
  view: LiveChannel };

/**
 * A list copy with its Instances' identities: who they are, where they run,
 * whether they are offline. It changes when one of those does, never on what
 * an Instance is doing, so rows built from it are not rebuilt per report.
 * Live work (activity, busy, usage) subscribes where it is drawn.
 */
export function useChannelWithInstanceIdentities(channel: ChannelSnapshot | null,
  source?: LiveChannelSource): LiveChannel | null {
  const held = useRef<IdentityView | null>(null);
  const select = useCallback((live: LiveChannel | null): LiveChannel | null => {
    if (!channel) return null;
    const next = new Map([...live?.presence?.instances ?? []].map(([id, instance]) => [id, instanceIdentity(instance)]));
    const prior = held.current;
    const instances = prior && sameValue(prior.instances, next) ? prior.instances : next;
    if (prior && prior.channel === channel && prior.instances === instances) return prior.view;
    const view: LiveChannel = { ...channel, presence: { channelId: channel.id,
      humans: channel.presence?.humans ?? new Map(), instances,
      ...(channel.presence?.humansCovered === false ? { humansCovered: false as const } : {}) } };
    held.current = { channel, instances, view };
    return view;
  }, [channel]);
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

/**
 * What select reads from each of a set of live Channels. A report reaches the
 * reader only when it changes a selection, so select should keep to what is
 * drawn (an Agent's status, not its activity).
 */
export function useRealtimeChannelsSelection<T>(ids: readonly string[],
  select: (channel: LiveChannel | undefined) => T): (id: string) => T | undefined {
  const store = useContext(RealtimeChannelsContext);
  const key = [...new Set(ids)].sort().join("\n");
  const held = useRef<{ key: string; select: typeof select; values: ReadonlyMap<string, T>;
    read: (id: string) => T | undefined } | null>(null);
  const subscribe = useCallback((notify: () => void) => {
    if (!store || !key) return noSubscription();
    const offs = key.split("\n").map(id => store.subscribeKey(id, notify));
    return () => { for (const off of offs) off(); };
  }, [store, key]);
  const snapshot = useCallback(() => {
    const values = new Map((key ? key.split("\n") : []).map(id => [id, select(store?.get(id))]));
    const prior = held.current;
    if (prior && prior.key === key && prior.select === select && sameValue(prior.values, values)) return prior.read;
    const read = (id: string) => values.get(id);
    held.current = { key, select, values, read };
    return read;
  }, [store, key, select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

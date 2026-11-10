"use client";

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { isLiveChannel, sameValue, type AgentInstancePresence, type ObservabilityEvent, type ChannelSnapshot, type LiveChannel,
  type PresenceInstanceId } from "@xmatrix/protocol";
import type { RealtimeCollection } from "./realtime-collection";

/** What a live read needs: each Channel as it stands now, its Instances included. */
export type LiveChannelSource = Pick<RealtimeCollection<LiveChannel>, "get" | "subscribeKey" | "getSnapshot" | "subscribe">;
export const RealtimeChannelsContext = createContext<LiveChannelSource | null>(null);
export type ChannelEventView = { id: string; events: readonly ObservabilityEvent[] };
export const RealtimeEventsContext = createContext<RealtimeCollection<ChannelEventView> | null>(null);

const noSubscription = () => () => {};
const NO_CHANNELS: LiveChannel[] = [];
const noChannels = () => NO_CHANNELS;
const wholeChannel = (channel: LiveChannel | null) => channel;

const unplacedViews = new WeakMap<ChannelSnapshot, LiveChannel>();
/** A Channel the live store does not hold. A decoded Channel (a preview, a
 * test) keeps its Instances; of a list copy none is known here. */
function withoutInstances(channel: ChannelSnapshot): LiveChannel {
  if (isLiveChannel(channel)) return channel;
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
 * leaving or going offline changes its status here; busy and idle read as
 * online. Rest and offlineReason stay, so residency reads as before. */
function instanceIdentity(instance: AgentInstancePresence): AgentInstancePresence {
  const { id, channelId, channelInstanceId, label, agentName, registration, email, connectedAt, rest,
    offlineReason, hostName, hostId, hostname, machineId, cwd, workspaceName, repository } = instance;
  return { id, channelId, channelInstanceId, label, agentName, registration, email, connectedAt, rest, offlineReason,
    hostName, hostId, hostname, machineId, cwd, workspaceName, repository,
    lastSeenAt: connectedAt, status: instance.status === "offline" ? "offline" : "online" };
}

/** Who wrote a message: name, registration and machine only. Nothing here
 * moves with a rest, an absence or a reconnect; the first sighting's time
 * stands in for the required timestamps. */
function senderIdentity(instance: AgentInstancePresence, seenAt: string): AgentInstancePresence {
  const { id, channelId, channelInstanceId, label, agentName, registration, email,
    hostName, hostId, hostname, machineId, cwd, workspaceName, repository } = instance;
  return { id, channelId, channelInstanceId, label, agentName, registration, email,
    hostName, hostId, hostname, machineId, cwd, workspaceName, repository,
    connectedAt: seenAt, lastSeenAt: seenAt, status: "online" };
}

type IdentityView = { channel: ChannelSnapshot; instances: ReadonlyMap<PresenceInstanceId, AgentInstancePresence>;
  view: LiveChannel };

function useIdentityView(channel: ChannelSnapshot | null, source: LiveChannelSource | undefined,
  identities: (live: LiveChannel | null, prior: IdentityView | null) => Map<PresenceInstanceId, AgentInstancePresence>) {
  const held = useRef<IdentityView | null>(null);
  const select = useCallback((live: LiveChannel | null): LiveChannel | null => {
    if (!channel) return null;
    const prior = held.current?.channel.id === channel.id ? held.current : null;
    const next = identities(live, prior);
    const instances = prior && sameValue(prior.instances, next) ? prior.instances : next;
    if (prior && prior.channel === channel && prior.instances === instances) return prior.view;
    const view: LiveChannel = { ...channel, presence: { channelId: channel.id,
      humans: channel.presence?.humans ?? new Map(), instances,
      ...(channel.presence?.humansCovered === false ? { humansCovered: false as const } : {}) } };
    held.current = { channel, instances, view };
    return view;
  }, [channel, identities]);
  return useRealtimeChannelSnapshot(channel, channel?.id ?? "", source, select);
}

const currentIdentities = (live: LiveChannel | null) => new Map([...live?.presence?.instances ?? []]
  .map(([id, instance]) => [id, instanceIdentity(instance)]));

/**
 * A list copy with its Instances' identities: who they are, where they run,
 * whether they are offline. It changes when one of those does, never on what
 * an Instance is doing. Live work (activity, busy, usage) subscribes where it
 * is drawn.
 */
export function useChannelWithInstanceIdentities(channel: ChannelSnapshot | null,
  source?: LiveChannelSource): LiveChannel | null {
  return useIdentityView(channel, source, currentIdentities);
}

const senderIdentities = (live: LiveChannel | null, prior: IdentityView | null) => {
  // Present Instances first: a sender matched by email or label alone resolves
  // to one still here before one that has left.
  const present = live?.presence?.instances ?? new Map<PresenceInstanceId, AgentInstancePresence>();
  const next = new Map([...present].map(([id, instance]) =>
    [id, senderIdentity(instance, prior?.instances.get(id)?.connectedAt ?? instance.connectedAt)]));
  for (const [id, identity] of prior?.instances ?? []) if (!next.has(id)) next.set(id, identity);
  return next;
};

/**
 * Who has written in this Channel, for the rows that name them: every
 * Instance seen while it is open, kept after it leaves (its messages still
 * name it), without status, rest or connection time. Only a new Instance or a moved one changes it,
 * so a report, a rest, a reconnect or a brief absence never rebuilds the rows.
 */
export function useChannelSenderIdentities(channel: ChannelSnapshot | null,
  source?: LiveChannelSource): LiveChannel | null {
  return useIdentityView(channel, source, senderIdentities);
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

/** Every live Channel, Instances included. It changes on every report, so
 * read it only where each report is drawn. */
export function useLiveChannels(): readonly LiveChannel[] {
  const store = useContext(RealtimeChannelsContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noChannels, store?.getSnapshot ?? noChannels);
}

import { parseInstanceRecord, mergeInstanceRecord, parseInstanceActivity, mergeInstanceActivity, presenceInstanceId,
  type InstanceRecord, type InstanceActivity, type ChannelSnapshot, type AgentInstancePresence } from "@xmatrix/protocol";
import { createRealtimeCollection, type RealtimeCollection, type RealtimeCollectionCommit } from "./realtime-collection";

/** Session-owned Instance facts. Channel lists are only metadata and query
 * windows; neither a late list nor an empty one can end a live Instance. */
export function createInstanceStore() {
  const records = createRealtimeCollection<InstanceRecord>();
  const activities = new Map<string, InstanceActivity>();
  type InstanceView = InstanceRecord & Pick<InstanceActivity, "activity" | "intent" | "files" | "runtimeState">;
  const byChannel = new Map<string, ReadonlyMap<string, InstanceView>>();
  const channelById = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const modern = new Set<string>();
  const changes = new Set<(ids: readonly string[]) => void>();
  const publish = (ids: readonly string[]) => {
    const touched = new Set<string>();
    for (const id of ids) {
      const record = records.get(id);
      if (record) touched.add(record.channelId);
      else { const channelId = channelById.get(id); if (channelId) touched.add(channelId); }
    }
    for (const channelId of touched) {
      const next = new Map(byChannel.get(channelId));
      for (const id of ids) {
        const record = records.get(id);
        if (record?.channelId === channelId) {
          const activity = activities.get(id);
          if (activity && (activity.revision.version !== record.revision.version ||
              activity.revision.sequence < record.revision.sequence)) activities.delete(id);
          const work = activities.get(id);
          // Work is live-only. A terminal record fences every old activity,
          // even when a trace or an activity packet arrives after the stop.
          const combined = work && (record.status !== "offline" || record.offlineReason) ? {
            ...record, activity: work.activity, intent: work.intent, files: work.files, runtimeState: work.runtimeState,
          } : record;
          next.set(id, combined);
          channelById.set(id, channelId);
        } else {
          next.delete(id);
          if (!record) { channelById.delete(id); activities.delete(id); }
        }
      }
      byChannel.set(channelId, next);
      for (const notify of listeners.get(channelId) ?? []) notify();
    }
    for (const notify of changes) notify([...touched]);
  };
  records.subscribeChanges(publish);
  return {
    get: records.get,
    getSnapshot: records.getSnapshot,
    subscribeChanges(notify: (ids: readonly string[]) => void) {
      changes.add(notify);
      return () => { changes.delete(notify); };
    },
    forgetChannels(ids: ReadonlySet<string>) {
      if (!ids.size) return;
      records.set(current => current.filter(record => !ids.has(record.channelId)), "live");
      for (const id of ids) { modern.delete(id); byChannel.delete(id); }
    },
    getChannel: (channelId: string) => byChannel.get(channelId),
    hasChannel: (channelId: string) => modern.has(channelId),
    receive(incoming: readonly InstanceRecord[], channelId?: string) {
      const parsed = incoming.map(parseInstanceRecord);
      if (channelId && parsed.some(record => record.channelId !== channelId)) throw new TypeError("Instance escaped its Channel");
      const updates = new Map<string, InstanceRecord>();
      for (const record of parsed) {
        const held = updates.get(record.id) ?? records.get(record.id);
        const next = mergeInstanceRecord(held, record);
        if (next !== held) updates.set(record.id, next);
      }
      if (channelId) modern.add(channelId);
      for (const record of parsed) modern.add(record.channelId);
      if (updates.size) records.receive([...updates.values()]);
    },
    receiveActivity(incoming: readonly InstanceActivity[]) {
      const updates = new Map<string, InstanceActivity>();
      for (const value of incoming) {
        const activity = parseInstanceActivity(value);
        const record = records.get(activity.instanceId);
        if (!record || record.channelId !== activity.channelId || record.revision.version !== activity.revision.version || activity.revision.sequence < record.revision.sequence ||
            record.status === "offline" && !record.offlineReason) continue;
        const held = updates.get(activity.instanceId) ?? activities.get(activity.instanceId);
        const next = mergeInstanceActivity(held, activity);
        if (next !== held) updates.set(activity.instanceId, next);
      }
      if (!updates.size) return;
      for (const [id, activity] of updates) activities.set(id, activity);
      publish([...updates.keys()]);
    },
    /** An exact read may remove only the record it was asked about. A newer
     * stream observation that arrived during the read must survive its miss. */
    reconcileMissing(ids: readonly string[], asked: ReadonlyMap<string, InstanceRecord>) {
      const missing = new Set(ids.filter(id => asked.get(id) === records.get(id)));
      if (missing.size) records.set(current => current.filter(record => !missing.has(record.id)), "live");
    },
    subscribeChannel(channelId: string, notify: () => void) {
      let own = listeners.get(channelId);
      if (!own) listeners.set(channelId, own = new Set());
      own.add(notify);
      return () => { own.delete(notify); if (!own.size) listeners.delete(channelId); };
    },
    clear() { modern.clear(); activities.clear(); records.set([]); byChannel.clear(); channelById.clear(); },
  };
}

export type InstanceStore = ReturnType<typeof createInstanceStore>;

/** Compatibility view for existing Channel selectors. Its Instance map is
 * derived from the one store, never copied back into the Channel catalog. */
export function createRealtimeChannels(initial: ChannelSnapshot[] = []) {
  const metadata = createRealtimeCollection<ChannelSnapshot>();
  const instances = createInstanceStore();
  const views = new Map<string, { channel: ChannelSnapshot; records: ReturnType<InstanceStore["getChannel"]>; view: ChannelSnapshot }>();
  const view = (channel: ChannelSnapshot | undefined) => {
    if (!channel || !instances.hasChannel(channel.id)) return channel;
    const records = instances.getChannel(channel.id);
    const held = views.get(channel.id);
    if (held?.channel === channel && held.records === records) return held.view;
    const map = new Map([...records?.values() ?? []].map(record => [presenceInstanceId(record.id),
      record as unknown as AgentInstancePresence]));
    const next = { ...channel, presence: { channelId: channel.id,
      humans: channel.presence?.humans ?? new Map(), instances: map,
      ...(channel.presence?.humansCovered === false ? { humansCovered: false as const } : {}) } };
    views.set(channel.id, { channel, records, view: next });
    return next;
  };
  const ingest = (channel: ChannelSnapshot): ChannelSnapshot => {
    const held = views.get(channel.id);
    if (held?.view === channel) return held.channel;
    const { instanceRecords, ...rest } = channel;
    delete rest.missingInstanceIds;
    if (instanceRecords) instances.receive(instanceRecords, channel.id);
    if (!instances.hasChannel(channel.id)) return channel;
    return { ...rest, presence: rest.presence ? { ...rest.presence, instances: new Map() } : undefined };
  };
  let basis: ChannelSnapshot[] | undefined;
  let snapshot: ChannelSnapshot[] = [];
  const getSnapshot = () => {
    const current = metadata.getSnapshot();
    const next = current.map(channel => view(channel)!);
    if (basis === current && next.every((channel, index) => channel === snapshot[index])) return snapshot;
    basis = current;
    return snapshot = next;
  };
  const store: RealtimeCollection<ChannelSnapshot> & { instances: InstanceStore } = {
    ...metadata,
    instances,
    get: id => view(metadata.get(id)),
    getSnapshot,
    subscribe(notify) {
      const offMetadata = metadata.subscribe(notify);
      const offInstances = instances.subscribeChanges(() => notify());
      return () => { offMetadata(); offInstances(); };
    },
    subscribeChanges(notify) {
      const offMetadata = metadata.subscribeChanges(notify);
      const offInstances = instances.subscribeChanges(notify);
      return () => { offMetadata(); offInstances(); };
    },
    subscribeKey(id, notify) {
      const offMetadata = metadata.subscribeKey(id, notify);
      const offInstances = instances.subscribeChannel(id, notify);
      return () => { offMetadata(); offInstances(); };
    },
    set(update, kind = "catalog") {
      const current = getSnapshot();
      const next = typeof update === "function" ? update(current) : update;
      if (next !== current) {
        const kept = new Set(next.map(channel => channel.id));
        const removed = new Set(current.filter(channel => !kept.has(channel.id)).map(channel => channel.id));
        instances.forgetChannels(removed);
        for (const id of removed) views.delete(id);
        metadata.set(next.map(ingest), kind);
      }
    },
    receive(incoming, capture) {
      const before = getSnapshot();
      metadata.receive(incoming.map(ingest), () => capture?.(getSnapshot(), before));
    },
    commit(commit: RealtimeCollectionCommit<ChannelSnapshot>, kind = "catalog") {
      const items = commit.items.map(ingest);
      metadata.commit({ ...commit, items, byId: new Map(items.map(channel => [channel.id, channel])) }, kind);
    },
  };
  if (initial.length) store.set(initial);
  return store;
}

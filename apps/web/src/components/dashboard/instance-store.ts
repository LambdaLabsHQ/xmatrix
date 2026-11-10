import { parseInstanceRecord, mergeInstanceRecord, parseInstanceActivity, mergeInstanceActivity, presenceInstanceId,
  accountQuotaUsageFromCandidates, withRegistrationQuota, mergeRegistrationPresentation,
  type RegistrationPresentation, type AgentRegistrationKey, type LlmUsage, type InstanceRecord, type InstanceActivity, type ChannelSnapshot, type LiveChannel, type AgentInstancePresence } from "@xmatrix/protocol";
import { createRealtimeCollection, type RealtimeCollection, type RealtimeCollectionCommit } from "./realtime-collection";

/** Session-owned Instance facts. Channel lists are only metadata and query
 * windows; neither a late list nor an empty one can end a live Instance. */
export function createInstanceStore() {
  const records = createRealtimeCollection<InstanceRecord>();
  const activities = new Map<string, InstanceActivity>();
  const quotas = new Map<string, LlmUsage>();
  const registrationKey = (key: AgentRegistrationKey) => JSON.stringify([key.ownerUserId, key.machineId, key.harness]);
  const registrations = new Map<string, RegistrationPresentation>();
  const channelSpaces = new Map<string, string>();
  const presentationKey = (spaceId: string, key: AgentRegistrationKey) => JSON.stringify([spaceId, registrationKey(key)]);
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
          const active = work && (record.status !== "offline" || record.offlineReason) ? {
            ...record, activity: work.activity, intent: work.intent, files: work.files, runtimeState: work.runtimeState,
          } : record;
          const quota = quotas.get(registrationKey(record.registration));
          const named = registrations.get(presentationKey(channelSpaces.get(channelId) ?? "", record.registration));
          const shown = named ? { ...active, agentName: named.displayName,
            label: `${named.displayName}:${record.channelInstanceId}` } : active;
          const combined = quota ? { ...shown, usage: withRegistrationQuota(shown.usage, quota) } : shown;
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
      for (const id of ids) { modern.delete(id); byChannel.delete(id); channelSpaces.delete(id); }
      const kept = records.getSnapshot();
      const accountKeys = new Set(kept.map(record => registrationKey(record.registration)));
      const nameKeys = new Set(kept.map(record => presentationKey(channelSpaces.get(record.channelId) ?? "", record.registration)));
      for (const key of quotas.keys()) if (!accountKeys.has(key)) quotas.delete(key);
      for (const key of registrations.keys()) if (!nameKeys.has(key)) registrations.delete(key);
    },
    getChannel: (channelId: string) => byChannel.get(channelId),
    hasChannel: (channelId: string) => modern.has(channelId),
    setChannelSpace(channelId: string, spaceId: string) { channelSpaces.set(channelId, spaceId); },
    receiveQuota(registration: AgentRegistrationKey, incoming: LlmUsage) {
      const key = registrationKey(registration);
      const held = quotas.get(key);
      const next = accountQuotaUsageFromCandidates(held, incoming);
      if (!next || JSON.stringify(next) === JSON.stringify(held)) return;
      quotas.set(key, next);
      publish(records.getSnapshot().filter(record => registrationKey(record.registration) === key).map(record => record.id));
    },
    receive(incoming: readonly InstanceRecord[], channelId?: string) {
      const parsed = incoming.map(parseInstanceRecord);
      if (channelId && parsed.some(record => record.channelId !== channelId)) throw new TypeError("Instance escaped its Channel");
      const updates = new Map<string, InstanceRecord>();
      const renamed = new Set<string>();
      for (const record of parsed) {
        const presentation = record.registrationPresentation;
        if (presentation) {
          const key = presentationKey(presentation.key.spaceId, presentation.key);
          if (!channelSpaces.has(record.channelId)) channelSpaces.set(record.channelId, presentation.key.spaceId);
          const held = registrations.get(key);
          const next = mergeRegistrationPresentation(held, presentation);
          if (next && next !== held) { registrations.set(key, next); renamed.add(key); }
        }
        const held = updates.get(record.id) ?? records.get(record.id);
        const { registrationPresentation: _presentation, ...fact } = record;
        const next = mergeInstanceRecord(held, fact);
        if (next !== held) updates.set(record.id, next);
      }
      if (channelId) modern.add(channelId);
      for (const record of parsed) modern.add(record.channelId);
      if (updates.size) records.receive([...updates.values()]);
      if (renamed.size) publish(records.getSnapshot().filter(record => renamed.has(
        presentationKey(channelSpaces.get(record.channelId) ?? "", record.registration))).map(record => record.id));
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
    clear() { modern.clear(); activities.clear(); quotas.clear(); registrations.clear(); channelSpaces.clear();
      records.set([]); byChannel.clear(); channelById.clear(); },
  };
}

export type InstanceStore = ReturnType<typeof createInstanceStore>;

/** The session's Channels. Live reads (get, getSnapshot, subscribe) are
 * LiveChannels: each carries its Instances, derived from the one Instance store.
 * Catalog reads are what lists hold, typed ChannelSnapshot, which has no
 * Instances, so a list copy cannot be handed to code that reads them. */
export type RealtimeChannels = Omit<RealtimeCollection<LiveChannel>, "getCatalogSnapshot" | "getCatalog"> & {
  instances: InstanceStore;
  getCatalogSnapshot: () => ChannelSnapshot[];
  getCatalog: (id: string) => ChannelSnapshot | undefined;
};

/** Its Instance map is derived from the one store, never copied back into the Channel catalog. */
export function createRealtimeChannels(initial: LiveChannel[] = []) {
  const metadata = createRealtimeCollection<LiveChannel>();
  const instances = createInstanceStore();
  const views = new Map<string, { channel: LiveChannel; records: ReturnType<InstanceStore["getChannel"]>; view: LiveChannel }>();
  const view = (channel: LiveChannel | undefined) => {
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
  const ingest = (channel: LiveChannel): LiveChannel => {
    const held = views.get(channel.id);
    if (held?.view === channel) return held.channel;
    const { instanceRecords, ...rest } = channel;
    delete rest.missingInstanceIds;
    if (channel.spaceId) instances.setChannelSpace(channel.id, channel.spaceId);
    // Channel reads carry the registration pool in the compatibility view;
    // it has its own observation time, independent of Instance revisions.
    for (const instance of channel.presence?.instances.values() ?? []) {
      if (instance.registration && instance.usage) instances.receiveQuota(instance.registration, instance.usage);
    }
    if (instanceRecords) instances.receive(instanceRecords, channel.id);
    if (!instances.hasChannel(channel.id)) return channel;
    return { ...rest, presence: rest.presence ? { ...rest.presence, instances: new Map() } : undefined };
  };
  let basis: LiveChannel[] | undefined;
  let snapshot: LiveChannel[] = [];
  const getSnapshot = () => {
    const current = metadata.getSnapshot();
    const next = current.map(channel => view(channel)!);
    if (basis === current && next.every((channel, index) => channel === snapshot[index])) return snapshot;
    basis = current;
    return snapshot = next;
  };
  const store: RealtimeChannels = {
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
    commit(commit: RealtimeCollectionCommit<LiveChannel>, kind = "catalog") {
      const items = commit.items.map(ingest);
      metadata.commit({ ...commit, items, byId: new Map(items.map(channel => [channel.id, channel])) }, kind);
    },
  };
  if (initial.length) store.set(initial);
  return store;
}

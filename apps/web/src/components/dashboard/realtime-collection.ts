/** A completed indexed reduction. The writer transfers ownership of byId and
 * must not mutate it after publication; changedKeys covers every possible
 * addition, removal or replacement since basis (or the current live snapshot
 * when no basis is supplied). */
export type RealtimeCollectionCommit<T extends { id: string }> = {
  /** When supplied, a superseded input requires a complete key comparison. */
  readonly basis?: T[];
  readonly items: T[];
  readonly byId: ReadonlyMap<string, T>;
  readonly changedKeys: readonly string[];
};

/** A session-owned projection. Catalog writes and explicit promotion update
 * catalog readers; live reports notify only their live subscribers. */
export function createRealtimeCollection<T extends { id: string }>(initial: T[] = [], orderBy?: (item: T) => string) {
  let live = initial;
  let catalog = initial;
  let byId: ReadonlyMap<string, T> = new Map(initial.map(item => [item.id, item]));
  let catalogById = byId;
  // Presentation order is private: inserting a newly seen Agent must not
  // rebuild the entire keyed index or materialize a public Agent array.
  let orderedIds = orderBy ? [...new Set(initial.map(item => item.id))] : undefined;
  let orderKnown = initial.length < 2;
  // Only receive owns a writable Map. External commits and catalog readers
  // may retain their indices, so the next receive must fork after either.
  let liveMapOwned = false;
  let snapshotDirty = false;
  const liveListeners = new Set<() => void>();
  const catalogListeners = new Set<() => void>();
  const keyListeners = new Map<string, Set<() => void>>();
  const changeListeners = new Set<(keys: readonly string[]) => void>();

  const listen = (listeners: Set<() => void>, callback: () => void) => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  };
  const snapshot = () => {
    if (snapshotDirty) {
      live = orderedIds ? orderedIds.map(id => byId.get(id)!) : [...byId.values()];
      snapshotDirty = false;
    }
    return live;
  };
  const notify = (changedKeys: readonly string[], catalogChanged: boolean) => {
    for (const id of changedKeys) for (const notify of keyListeners.get(id) ?? []) notify();
    if (changedKeys.length) for (const notify of changeListeners) notify(changedKeys);
    for (const notify of liveListeners) notify();
    if (catalogChanged) for (const notify of catalogListeners) notify();
  };
  const publish = (next: T[], nextById: ReadonlyMap<string, T>, changedKeys: readonly string[], kind: "catalog" | "live",
    receive?: { captureSnapshot?: (items: T[], previous: T[]) => void; previous?: T[] }) => {
    const nextOrder = orderBy ? [...new Set(next.map(item => item.id))] : undefined;
    live = next;
    byId = nextById;
    orderedIds = nextOrder;
    // External arrays keep their supplied order until a real name/addition
    // change requires sorting; a completed receive sort is already ordered.
    orderKnown = receive !== undefined || next.length < 2;
    snapshotDirty = false;
    const catalogChanged = kind === "catalog";
    liveMapOwned = receive !== undefined && !catalogChanged;
    if (catalogChanged) { catalog = live; catalogById = byId; }
    // Publish every snapshot before any subscriber is called.
    receive?.captureSnapshot?.(next, receive.previous!);
    notify(changedKeys, catalogChanged);
  };
  return {
    getSnapshot: snapshot,
    getCatalogSnapshot: () => catalog,
    get: (id: string) => byId.get(id),
    getCatalog: (id: string) => catalogById.get(id),
    /** Refresh the durable projection without publishing live data twice. */
    promote() {
      const current = snapshot();
      if (catalog === current) return;
      catalog = current;
      catalogById = byId;
      liveMapOwned = false;
      for (const notify of catalogListeners) notify();
    },
    subscribe: (callback: () => void) => listen(liveListeners, callback),
    subscribeCatalog: (callback: () => void) => listen(catalogListeners, callback),
    subscribeChanges(callback: (keys: readonly string[]) => void) {
      changeListeners.add(callback);
      return () => { changeListeners.delete(callback); };
    },
    subscribeKey(id: string, callback: () => void) {
      let listeners = keyListeners.get(id);
      if (!listeners) keyListeners.set(id, listeners = new Set());
      const unlisten = listen(listeners, callback);
      return () => {
        unlisten();
        if (!listeners.size) keyListeners.delete(id);
      };
    },
    set(update: T[] | ((current: T[]) => T[]), kind: "catalog" | "live" = "catalog") {
      const current = snapshot();
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      const nextById = new Map(next.map(item => [item.id, item]));
      const changedKeys: string[] = [];
      if (orderedIds) {
        for (const id of orderedIds) if (nextById.get(id) !== byId.get(id)) changedKeys.push(id);
      } else {
        for (const [id, item] of byId) if (nextById.get(id) !== item) changedKeys.push(id);
      }
      for (const id of nextById.keys()) if (!byId.has(id)) changedKeys.push(id);
      publish(next, nextById, changedKeys, kind);
    },
    /** Publish an already indexed reduction without rebuilding or diffing the
     * whole collection. Ordinary callers keep the complete set() fallback. */
    commit(commit: RealtimeCollectionCommit<T>, kind: "catalog" | "live" = "catalog") {
      const current = snapshot();
      if (commit.items === current) return;
      const candidates = commit.basis !== undefined && commit.basis !== current
        ? new Set([...(orderedIds ?? byId.keys()), ...commit.byId.keys()]) : new Set(commit.changedKeys);
      const changedKeys = [...candidates].filter(id =>
        byId.get(id) !== commit.byId.get(id));
      publish(commit.items, commit.byId, changedKeys, kind);
    },
    /** Whole live cards replace by id; a complete array is needed only by a
     * reader. Name changes sort now so stable ties retain cross-batch order. */
    receive(incoming: readonly T[], captureSnapshot?: (items: T[], previous: T[]) => void) {
      const previous = captureSnapshot ? snapshot() : undefined;
      if (!incoming.length) {
        captureSnapshot?.(previous!, previous!);
        return;
      }
      const updates = new Map(incoming.map(item => [item.id, item]));
      const changedKeys: string[] = [];
      const added: T[] = [];
      let renamed = false;
      for (const [id, after] of updates) {
        const before = byId.get(id);
        if (before !== after) changedKeys.push(id);
        if (orderBy) {
          const name = orderBy(after);
          if (typeof name !== "string") throw new Error("Invalid realtime ordering key");
          if (!before) added.push(after);
          else if (orderBy(before) !== name) renamed = true;
        }
      }
      let nextOrder = orderedIds;
      if ((renamed || added.length) && orderBy) {
        // Finish every comparison on a private candidate before changing the
        // keyed cards: a failed ordering must not poison a later good report.
        if (orderKnown && !renamed && added.length <= 8) {
          nextOrder = orderedIds!.slice();
          for (const item of added) {
            const name = orderBy(item);
            let low = 0;
            let high = nextOrder.length;
            while (low < high) {
              const middle = (low + high) >>> 1;
              const id = nextOrder[middle];
              const resident = updates.get(id) ?? byId.get(id)!;
              if (name.localeCompare(orderBy(resident)) >= 0) low = middle + 1;
              else high = middle;
            }
            // New same-name cards follow existing ties and each other in
            // their first-seen order, exactly as a stable full sort would.
            nextOrder.splice(low, 0, item.id);
          }
        } else {
          const items = orderedIds!.map(id => updates.get(id) ?? byId.get(id)!);
          items.push(...added);
          items.sort((left, right) => orderBy(left).localeCompare(orderBy(right)));
          publish(items, new Map(items.map(item => [item.id, item])), changedKeys, "live", { captureSnapshot, previous });
          return;
        }
      }
      if (changedKeys.length) {
        const writable = liveMapOwned ? byId as Map<string, T> : new Map(byId);
        for (const id of changedKeys) writable.set(id, updates.get(id)!);
        byId = writable;
        liveMapOwned = true;
      }
      orderedIds = nextOrder;
      if (added.length) orderKnown = true;
      // Even identical nonempty cards retain the ordinary writer's new live
      // snapshot/global notification, without notifying unchanged keys.
      snapshotDirty = true;
      // A reducer may retain routing for exactly this publication. Capture
      // its identity before a synchronous listener can publish another one.
      captureSnapshot?.(snapshot(), previous!);
      notify(changedKeys, false);
    },
  };
}

export type RealtimeCollection<T extends { id: string }> = ReturnType<typeof createRealtimeCollection<T>>;

/** Incremental existence query: unchanged keys are never re-evaluated on a
 * live report, including the worst case where nothing currently matches. */
export function realtimeCollectionAny<T extends { id: string }>(store: RealtimeCollection<T>, matches: (item: T) => boolean) {
  let source = store.getSnapshot();
  let matching = new Set(source.filter(matches).map(item => item.id));
  let watching = false;
  let stopWatching: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const update = (keys: readonly string[]) => {
    source = store.getSnapshot();
    const before = matching.size > 0;
    for (const id of keys) {
      const item = store.get(id);
      if (item && matches(item)) matching.add(id);
      else matching.delete(id);
    }
    if (before !== (matching.size > 0)) for (const notify of listeners) notify();
  };
  return {
    invalidate: update,
    getSnapshot() {
      if (!watching && source !== store.getSnapshot()) {
        source = store.getSnapshot();
        matching = new Set(source.filter(matches).map(item => item.id));
      }
      return matching.size > 0;
    },
    subscribe(notify: () => void) {
      if (source !== store.getSnapshot()) {
        source = store.getSnapshot();
        matching = new Set(source.filter(matches).map(item => item.id));
      }
      watching = true;
      listeners.add(notify);
      stopWatching ??= store.subscribeChanges(update);
      return () => {
        listeners.delete(notify);
        watching = listeners.size > 0;
        if (!watching) { stopWatching?.(); stopWatching = undefined; }
      };
    },
  };
}

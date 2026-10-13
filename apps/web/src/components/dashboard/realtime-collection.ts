/** A session-owned projection. Only authoritative reads change the catalog;
 * live reports notify the keys they changed, without invalidating that catalog. */
export function createRealtimeCollection<T extends { id: string }>(initial: T[] = []) {
  let live = initial;
  let catalog = initial;
  let byId = new Map(initial.map(item => [item.id, item]));
  let catalogById = byId;
  const liveListeners = new Set<() => void>();
  const catalogListeners = new Set<() => void>();
  const keyListeners = new Map<string, Set<() => void>>();
  const changeListeners = new Set<(keys: readonly string[]) => void>();

  const listen = (listeners: Set<() => void>, callback: () => void) => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  };
  return {
    getSnapshot: () => live,
    getCatalogSnapshot: () => catalog,
    get: (id: string) => byId.get(id),
    getCatalog: (id: string) => catalogById.get(id),
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
      const next = typeof update === "function" ? update(live) : update;
      const liveChanged = next !== live;
      const changedKeys: string[] = [];
      if (liveChanged) {
        const nextById = new Map(next.map(item => [item.id, item]));
        for (const [id, item] of byId) if (nextById.get(id) !== item) changedKeys.push(id);
        for (const id of nextById.keys()) if (!byId.has(id)) changedKeys.push(id);
        live = next;
        byId = nextById;
      }
      const catalogChanged = kind === "catalog" && liveChanged;
      if (catalogChanged) { catalog = live; catalogById = byId; }
      // Publish every snapshot before any subscriber is called.
      for (const id of changedKeys) for (const notify of keyListeners.get(id) ?? []) notify();
      if (changedKeys.length) for (const notify of changeListeners) notify(changedKeys);
      if (liveChanged) for (const notify of liveListeners) notify();
      if (catalogChanged) for (const notify of catalogListeners) notify();
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

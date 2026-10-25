import { useSyncExternalStore } from "react";

/** A widget's element, the key its portal is drawn under, and what it is drawn with. */
export type WidgetPortal<T> = { element: HTMLElement; key: string } & T;

/**
 * The editor's widgets are plain DOM; what React draws into them is drawn from inside the page's own tree, so it
 * reads as everything else there does (the reader, their Space, their queries), not from a tree of its own.
 */
export function widgetPortals<T>(name: string) {
  const portals = new Map<HTMLElement, WidgetPortal<T>>();
  const listeners = new Set<() => void>();
  /** What is drawn, as a new list on every change: the page renders from it, so its render is never stale. */
  let drawn: readonly WidgetPortal<T>[] = [];
  let nextKey = 0;
  const changed = () => {
    drawn = [...portals.values()];
    for (const listener of listeners) listener();
  };
  const drawnNow = () => drawn;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return {
    /** Draws into a widget; the returned function takes it down. */
    mount(element: HTMLElement, value: T): () => void {
      portals.set(element, { ...value, element, key: `${name}-${nextKey++}` });
      changed();
      // The editor drops a widget while React may be rendering; take it down after.
      return () => queueMicrotask(() => {
        if (portals.delete(element)) changed();
      });
    },
    /** Every widget drawn into now. */
    useDrawn: (): readonly WidgetPortal<T>[] => useSyncExternalStore(subscribe, drawnNow, drawnNow),
  };
}

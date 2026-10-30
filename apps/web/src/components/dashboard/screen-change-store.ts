"use client";

import { useRef } from "react";

/**
 * A screen change the shell announces to the small layer that draws it,
 * without rendering itself: the layer subscribes, the shell only sets.
 */
export type ScreenChangeStore<T> = {
  subscribe: (listener: () => void) => () => void;
  get: () => T | null;
  set: (value: T | null) => void;
};

export function useScreenChangeStore<T>(): ScreenChangeStore<T> {
  const store = useRef<ScreenChangeStore<T> | null>(null);
  if (!store.current) {
    let value: T | null = null;
    const listeners = new Set<() => void>();
    store.current = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get: () => value,
      set: (next) => {
        value = next;
        for (const listener of listeners) listener();
      },
    };
  }
  return store.current;
}

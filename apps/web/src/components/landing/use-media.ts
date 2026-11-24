"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** Whether the window matches a media query. False on the server and until the browser has been asked. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/**
 * Whether an element has come within a screen of the window, and the ref that
 * watches it. Once true it stays true: what was mounted for it is not taken
 * down again. A stage mounts the product in it on this, so a visitor who never
 * scrolls that far neither downloads nor runs it.
 */
export function useNear<T extends Element>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!node || near) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: "100% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, near]);
  return [setNode, near];
}

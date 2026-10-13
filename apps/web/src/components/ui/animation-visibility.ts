"use client";

import { useCallback } from "react";

let observer: IntersectionObserver | undefined;
const registered = new Map<HTMLElement, symbol>();

/** One viewport observer follows only explicitly registered animation hosts.
 * Its default root includes clipping by every scrolling ancestor. */
function observeAnimationVisibility(element: HTMLElement) {
  if (typeof IntersectionObserver !== "function") return;
  observer ??= new IntersectionObserver((entries, source) => {
    if (source !== observer) return;
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      if (registered.has(target)) {
        target.dataset.animationVisible = String(entry.isIntersecting
          && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
      }
    }
  }, { threshold: [0, Number.EPSILON] });
  const token = Symbol();
  if (registered.has(element)) observer.unobserve(element);
  registered.set(element, token);
  element.dataset.animationVisible = "false";
  observer.observe(element);
  return () => {
    // A stale ref cleanup cannot remove a newer registration of the same node.
    if (registered.get(element) !== token) return;
    registered.delete(element);
    observer?.unobserve(element);
    delete element.dataset.animationVisible;
    if (!registered.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

/** React 19 invokes the returned ref cleanup on node replacement, unmount and
 * StrictMode's extra attach cycle. Visibility changes never set React state. */
export function useAnimationVisibility(enabled = true) {
  return useCallback((element: HTMLElement | null) => {
    if (element && enabled) return observeAnimationVisibility(element);
  }, [enabled]);
}

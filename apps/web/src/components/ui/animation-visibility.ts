"use client";

import { useCallback } from "react";

let observer: IntersectionObserver | undefined;
const registered = new Map<HTMLElement, { token: symbol; onVisible?: (visible: boolean) => void }>();

/** One viewport observer follows only explicitly registered animation hosts.
 * Its default root includes clipping by every scrolling ancestor. */
export function observeAnimationVisibility(element: HTMLElement, onVisible?: (visible: boolean) => void) {
  if (typeof IntersectionObserver !== "function") {
    onVisible?.(true);
    return;
  }
  observer ??= new IntersectionObserver((entries, source) => {
    if (source !== observer) return;
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const registration = registered.get(target);
      if (registration) {
        const visible = entry.isIntersecting
          && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
        target.dataset.animationVisible = String(visible);
        registration.onVisible?.(visible);
      }
    }
  }, { threshold: [0, Number.EPSILON] });
  const token = Symbol();
  if (registered.has(element)) observer.unobserve(element);
  registered.set(element, { token, onVisible });
  element.dataset.animationVisible = "false";
  onVisible?.(false);
  observer.observe(element);
  return () => {
    // A stale ref cleanup cannot remove a newer registration of the same node.
    if (registered.get(element)?.token !== token) return;
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

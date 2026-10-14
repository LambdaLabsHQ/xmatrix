"use client";

import { useCallback } from "react";

type Root = Element | Document | null;
type ObserverGroup = { root: Root; observer: IntersectionObserver; count: number };
type Registration = { token: symbol; group: ObserverGroup; onVisible?: (visible: boolean) => void };
const observers = new Map<Root, ObserverGroup>();
const registered = new Map<HTMLElement, Registration>();

function observerFor(root: Root): ObserverGroup {
  let group = observers.get(root);
  if (group) return group;
  const observer = new IntersectionObserver((entries, source) => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const registration = registered.get(target);
      if (registration?.group.observer !== source) continue;
      const visible = entry.isIntersecting
        && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      target.dataset.animationVisible = String(visible);
      registration.onVisible?.(visible);
    }
  }, { root, threshold: [0, Number.EPSILON] });
  group = { root, observer, count: 0 };
  observers.set(root, group);
  return group;
}

function release(element: HTMLElement, registration: Registration) {
  registered.delete(element);
  const group = registration.group;
  group.observer.unobserve(element);
  group.count--;
  if (!group.count) {
    group.observer.disconnect();
    observers.delete(group.root);
  }
}

/** One observer per explicit root. The default viewport root and its clipping
 * semantics are unchanged; related effects may use their existing scroller. */
export function observeAnimationVisibility(element: HTMLElement, onVisible?: (visible: boolean) => void, root: Root = null) {
  if (typeof IntersectionObserver !== "function") {
    onVisible?.(true);
    return;
  }
  const previous = registered.get(element);
  if (previous) release(element, previous);
  const group = observerFor(root);
  const token = Symbol();
  const registration = { token, group, onVisible };
  group.count++;
  registered.set(element, registration);
  element.dataset.animationVisible = "false";
  onVisible?.(false);
  group.observer.observe(element);
  return () => {
    // A stale ref cleanup cannot remove a newer registration of the same node.
    if (registered.get(element)?.token !== token) return;
    release(element, registration);
    delete element.dataset.animationVisible;
  };
}

/** React 19 invokes the returned ref cleanup on node replacement, unmount and
 * StrictMode's extra attach cycle. Visibility changes never set React state. */
export function useAnimationVisibility(enabled = true) {
  return useCallback((element: HTMLElement | null) => {
    if (element && enabled) return observeAnimationVisibility(element);
  }, [enabled]);
}

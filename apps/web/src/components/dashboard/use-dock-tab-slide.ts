"use client";

import { useLayoutEffect, useRef, type MutableRefObject } from "react";

/*
 * Switching dock tabs on a phone moves the whole page: the track carries the
 * tabs' screens (globals.css, .app-mobile-dock-track) and the bar with its wood
 * sign goes with them. Every tab's own screen has the same bar, the Space's
 * sign and search, so the bar being left is drawn as a copy that slides out
 * with its page while the bar slides in with the new one, on the track's own
 * duration and curve (DockTabSlideLayer). Going a level up or down keeps the
 * sign still instead (use-mobile-list-transition.ts); that is how the two read
 * apart. The slide is announced through a store, so only the layer renders.
 */
export type DockTabSlide = { key: number; direction: 1 | -1 };

export type DockTabSlideStore = {
  subscribe: (listener: () => void) => () => void;
  get: () => DockTabSlide | null;
  set: (slide: DockTabSlide | null) => void;
};

export function useDockTabSlide({ slot, tabRootShowing, tabTapped }: {
  /** The dock tab whose screen the track shows. */
  slot: number;
  /** The bar is a dock tab's own: no screen is pushed over the tabs. */
  tabRootShowing: boolean;
  /** Set by a tap on a dock tab (the web dock or the native tab bar). Only that
      moves the bar; the app settling on the tab its address names does not. */
  tabTapped: MutableRefObject<boolean>;
}): DockTabSlideStore {
  const storeRef = useRef<DockTabSlideStore | null>(null);
  if (!storeRef.current) {
    let slide: DockTabSlide | null = null;
    const listeners = new Set<() => void>();
    storeRef.current = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get: () => slide,
      set: (next) => {
        slide = next;
        for (const listener of listeners) listener();
      },
    };
  }
  const store = storeRef.current;
  const previousSlot = useRef(slot);

  useLayoutEffect(() => {
    const from = previousSlot.current;
    previousSlot.current = slot;
    if (from === slot) return;
    const tapped = tabTapped.current;
    tabTapped.current = false;
    if (tapped && tabRootShowing) store.set({ key: performance.now(), direction: slot > from ? 1 : -1 });
  }, [slot, store, tabRootShowing, tabTapped]);

  return store;
}

/** Slides the bar in with the new tab's page and its copy out with the old one, on the track's timing. */
export function slideDockTabBars(root: HTMLElement, slide: DockTabSlide): Animation | null {
  const track = root.querySelector<HTMLElement>(".app-mobile-dock-track");
  const style = track ? getComputedStyle(track) : null;
  // Reduced motion leaves the track without a transition; the bar does not move either.
  const duration = parseFloat(style?.transitionDuration ?? "0") * 1000;
  if (!style || !duration) return null;
  const timing = { duration, easing: style.transitionTimingFunction };
  const bar = root.querySelector<HTMLElement>(
    ".app-topbar.app-mobile-tab-root-bar:not(.app-dock-tab-slide-outgoing, .app-list-transition-target)");
  const ghost = root.querySelector<HTMLElement>(".app-dock-tab-slide-outgoing");
  bar?.animate([{ transform: `translateX(${slide.direction * 100}%)` }, { transform: "none" }], timing);
  return ghost?.animate([{ transform: "none" }, { transform: `translateX(${-slide.direction * 100}%)` }],
    { ...timing, fill: "forwards" }) ?? null;
}

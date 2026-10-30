"use client";

import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

/*
 * Switching dock tabs on a phone moves the whole page: the track carries the
 * tabs' screens (globals.css, .app-mobile-dock-track) and the bar with its wood
 * sign goes with them. Every tab's own screen has the same bar, the Space's
 * sign and search, so the bar being left is drawn as a copy that slides out
 * with its page while the bar slides in with the new one, on the track's own
 * duration and curve. Going a level up or down keeps the sign still instead
 * (use-mobile-list-transition.ts); that is how the two read apart.
 */
export type DockTabSlide = { key: number; direction: 1 | -1 };

export function useDockTabSlide({ slot, tabRootShowing, rootRef, tabTapped }: {
  /** The dock tab whose screen the track shows. */
  slot: number;
  /** The bar is a dock tab's own: no screen is pushed over the tabs. */
  tabRootShowing: boolean;
  rootRef: MutableRefObject<HTMLElement | null>;
  /** Set by a tap on a dock tab (the web dock or the native tab bar). Only that
      moves the bar; the app settling on the tab its address names does not. */
  tabTapped: MutableRefObject<boolean>;
}): DockTabSlide | null {
  const [slide, setSlide] = useState<DockTabSlide | null>(null);
  const previousSlot = useRef(slot);

  useLayoutEffect(() => {
    const from = previousSlot.current;
    previousSlot.current = slot;
    if (from === slot) return;
    const tapped = tabTapped.current;
    tabTapped.current = false;
    if (tapped && tabRootShowing) setSlide({ key: performance.now(), direction: slot > from ? 1 : -1 });
  }, [slot, tabRootShowing, tabTapped]);

  useLayoutEffect(() => {
    if (!slide) return;
    const clear = () => setSlide((current) => current === slide ? null : current);
    const root = rootRef.current;
    const track = root?.querySelector<HTMLElement>(".app-mobile-dock-track");
    const style = track ? getComputedStyle(track) : null;
    // Reduced motion leaves the track without a transition; the bar does not move either.
    const duration = parseFloat(style?.transitionDuration ?? "0") * 1000;
    if (!root || !style || !duration) {
      clear();
      return;
    }
    const timing = { duration, easing: style.transitionTimingFunction };
    const bar = root.querySelector<HTMLElement>(
      ".app-topbar.app-mobile-tab-root-bar:not(.app-dock-tab-slide-outgoing, .app-list-transition-target)");
    const ghost = root.querySelector<HTMLElement>(".app-dock-tab-slide-outgoing");
    const incoming = bar?.animate([{ transform: `translateX(${slide.direction * 100}%)` }, { transform: "none" }], timing);
    const outgoing = ghost?.animate([{ transform: "none" }, { transform: `translateX(${-slide.direction * 100}%)` }],
      { ...timing, fill: "forwards" });
    const finished = (outgoing ?? incoming)?.finished;
    if (finished) finished.then(clear, clear);
    else clear();
    return () => {
      incoming?.cancel();
      outgoing?.cancel();
    };
  }, [rootRef, slide]);

  return slide;
}

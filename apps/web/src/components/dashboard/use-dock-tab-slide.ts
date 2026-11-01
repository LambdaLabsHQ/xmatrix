"use client";

import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";

import { useScreenChangeStore, type ScreenChangeStore } from "./screen-change-store";
import { startAfterPaint } from "./start-after-paint";

/*
 * Switching dock tabs on a phone moves the whole page: the track carries the
 * tabs' screens (globals.css, .app-mobile-dock-track) and the bar with its wood
 * sign goes with them. Every tab's own screen has the same bar, the Space's
 * sign and search, so the bar being left is drawn as a copy that slides out
 * with its page while the bar slides in with the new one, on the track's own
 * duration and curve (DockTabSlideLayer). Going a level up or down keeps the
 * sign still instead (use-mobile-list-transition.ts); that is how the two read
 * apart. The slide is announced through a store, so only the layer renders.
 *
 * The track and the bars move by animations started here, not by a CSS
 * transition: the new tab's screen is rendered on the same frame, and a
 * transition started there showed on iOS only its last few points
 * (start-after-paint.ts). Each starts once that frame is on the screen.
 */
export type DockTabSlide = { key: number; direction: 1 | -1 };

export type DockTabSlideStore = ScreenChangeStore<DockTabSlide> & {
  /** The track the tabs' screens sit on; the shell hands it here. */
  trackRef: MutableRefObject<HTMLDivElement | null>;
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
  const store = useScreenChangeStore<DockTabSlide>();
  const previousSlot = useRef(slot);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const trackSlide = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const from = previousSlot.current;
    previousSlot.current = slot;
    if (from === slot) return;
    const track = trackRef.current;
    const timing = track ? dockTrackTiming(track) : null;
    trackSlide.current?.cancel();
    trackSlide.current = null;
    if (track && timing) {
      // From the old tab's screen to the new one's; the track's style holds the new one after.
      const animation = track.animate([{ transform: slotTransform(from) }, { transform: slotTransform(slot) }], timing);
      trackSlide.current = animation;
      startAfterPaint([animation]);
    }
    const tapped = tabTapped.current;
    tabTapped.current = false;
    if (tapped && tabRootShowing) store.set({ key: performance.now(), direction: slot > from ? 1 : -1 });
  }, [slot, store, tabRootShowing, tabTapped]);

  return useMemo(() => ({ ...store, trackRef }), [store]);
}

const slotTransform = (slot: number) => `translate3d(${slot * -25}%, 0, 0)`;

/** The track's duration and curve (globals.css); null under reduced motion, where nothing moves. */
function dockTrackTiming(track: HTMLElement): KeyframeAnimationOptions | null {
  const style = getComputedStyle(track);
  const duration = parseFloat(style.getPropertyValue("--app-mobile-dock-duration"));
  if (!duration) return null;
  return { duration, easing: style.getPropertyValue("--app-mobile-dock-easing").trim() || "ease-out" };
}

/** Slides the bar in with the new tab's page and its copy out with the old one, on the track's timing. */
export function slideDockTabBars(root: HTMLElement, slide: DockTabSlide): Animation | null {
  const track = root.querySelector<HTMLElement>(".app-mobile-dock-track");
  // Reduced motion leaves the track still; the bar does not move either.
  const timing = track ? dockTrackTiming(track) : null;
  if (!timing) return null;
  const bar = root.querySelector<HTMLElement>(
    ".app-topbar.app-mobile-tab-root-bar:not(.app-dock-tab-slide-outgoing, .app-list-transition-target)");
  const ghost = root.querySelector<HTMLElement>(".app-dock-tab-slide-outgoing");
  const arriving = bar?.animate([{ transform: `translateX(${slide.direction * 100}%)` }, { transform: "none" }], timing);
  const leaving = ghost?.animate([{ transform: "none" }, { transform: `translateX(${-slide.direction * 100}%)` }],
    { ...timing, fill: "forwards" }) ?? null;
  // On the frame the track starts, held as it is (start-after-paint.ts).
  startAfterPaint([arriving, leaving]);
  return leaving;
}

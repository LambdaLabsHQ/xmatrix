"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { flushSync } from "react-dom";

import { useScreenChangeStore, type ScreenChangeStore } from "./screen-change-store";
import { SPRING_SAMPLES, springDuration, springOffset, springProgress, springSpeed } from "./screen-spring";
import { startAfterPaint } from "./start-after-paint";

/*
 * Switching dock tabs on a phone moves the whole page: the track carries the
 * tabs' screens (globals.css, .app-mobile-dock-track) and the bar with its wood
 * sign goes with them. Every tab's own screen has the same bar, the Space's
 * sign and search, so one copy of the bar slides out with the page being left
 * while the other slides in with the new one. Going a level up or down keeps
 * the sign still instead (use-mobile-list-transition.ts); that is how the two
 * read apart. Both move by the same spring (screen-spring.ts).
 *
 * A tap moves first and renders after, as Back to the channel list does. The
 * tab's screen is already on the track, mounted and painted, so the track, the
 * bar and a copy of it start on the compositor at once, and the shell renders
 * the new tab only once they land, while nothing moves. Rendering first held
 * the slide back on iOS by the shell's render and by the restyle of the two
 * screens whose `inert` changes, several frames before anything moved.
 *
 * A tab whose screen has not been shown yet, and a change the app makes by
 * itself (its address, a notification), renders first; that slide starts once
 * the frame painting the new screen is out (start-after-paint.ts), and its bar
 * copy is drawn by DockTabSlideLayer.
 */
/** `span`: how many tabs along the new one is, which the bars cross in the track's time. */
export type DockTabSlide = { key: number; direction: 1 | -1; span: number };

export type DockTabSlideStore = ScreenChangeStore<DockTabSlide> & {
  /** The track the tabs' screens sit on; the shell hands it here. */
  trackRef: MutableRefObject<HTMLDivElement | null>;
  /** The slot a slide under way is going to, for the tab bars to mark from the moment it starts. */
  pending: ScreenChangeStore<number>;
  /**
   * Moves to the tab in `slot` now and calls `commit` once the page has landed
   * there; false when the change has to render first, and the caller commits it now.
   * `create`: the new tab's screen has the + (the old one's slides out with it).
   */
  slideTo: (slot: number, commit: () => void, options: { create: boolean }) => boolean;
};

/** The live bar of a dock tab's own screen, not a copy drawn for a change. */
const TAB_ROOT_BAR =
  ".app-topbar.app-mobile-tab-root-bar:not(.app-dock-tab-slide-outgoing, .app-dock-tab-slide-incoming, .app-list-transition-target)";
const CREATE_FAB = ".app-mobile-create-fab:not(.app-list-transition-controls *)";

type Slide = {
  slot: number;
  commit: () => void;
  /** The track's offsets in px, and the speed it left `from` at. */
  from: number;
  to: number;
  speed: number;
  track: Animation;
  /** The bars, the + leaving and the bar's copy, which go when the slide lands. */
  others: Animation[];
  copy: HTMLElement | null;
  /** The + was not on the screen being left; the new one's fades in once it lands. */
  createArrives: boolean;
};

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The track from `from` to `to` px, leaving at `speed` px/s; it holds `to` until the slide lands. */
function moveTrack(track: HTMLElement, from: number, to: number, speed: number): Animation {
  const offset = from - to;
  const duration = springDuration(offset, speed);
  const frames = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => {
    const x = index === SPRING_SAMPLES ? to : to + springOffset(offset, speed, (duration * index) / SPRING_SAMPLES);
    return { transform: `translate3d(${x}px, 0, 0)` };
  });
  return track.animate(frames, { duration: duration * 1000, easing: "linear", fill: "forwards" });
}

/** `from` to `to` along the spring from rest, over `duration` s, as `unit` transforms. */
function springFrames(from: number, to: number, duration: number, unit: (value: number) => string): Keyframe[] {
  return Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => {
    const progress = index === SPRING_SAMPLES ? 1 : springProgress((duration * index) / SPRING_SAMPLES);
    return { transform: unit(from + (to - from) * progress) };
  });
}

const percentX = (value: number) => `translateX(${value}%)`;
const pixelX = (value: number) => `translateX(${value}px)`;

/** A copy of the bar to come in with the new screen: the same sign and search, out of reach. */
function copyBar(bar: HTMLElement): HTMLElement {
  const copy = bar.cloneNode(true) as HTMLElement;
  copy.classList.add("app-dock-tab-slide-incoming");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");
  bar.after(copy);
  return copy;
}

export function useDockTabSlide({ slot, tabRootShowing, tabTapped, rootRef }: {
  /** The dock tab whose screen the track shows. */
  slot: number;
  /** The bar is a dock tab's own: no screen is pushed over the tabs. */
  tabRootShowing: boolean;
  /** Set by a tap on a dock tab that renders first. Only that moves the bar;
      the app settling on the tab its address names does not. */
  tabTapped: MutableRefObject<boolean>;
  rootRef: MutableRefObject<HTMLElement | null>;
}): DockTabSlideStore {
  const store = useScreenChangeStore<DockTabSlide>();
  const pending = useScreenChangeStore<number>();
  const previousSlot = useRef(slot);
  const trackRef = useRef<HTMLDivElement | null>(null);
  /** A slide that renders first. */
  const trackSlide = useRef<Animation | null>(null);
  /** A slide that moves first, until it lands. */
  const running = useRef<Slide | null>(null);
  /** The shell is rendering the tab a slide has landed on. */
  const landing = useRef(false);
  const shown = useRef({ slot, tabRootShowing });
  shown.current = { slot, tabRootShowing };

  const controller = useMemo(() => {
    const putAway = (slide: Slide) => {
      if (running.current === slide) running.current = null;
      slide.track.cancel();
      for (const animation of slide.others) animation.cancel();
      slide.copy?.remove();
      pending.set(null);
    };

    const land = (slide: Slide) => {
      landing.current = true;
      try {
        // The new tab renders under the page as it stands; nothing moves while it does.
        flushSync(slide.commit);
      } finally {
        landing.current = false;
      }
      putAway(slide);
      if (slide.createArrives) {
        rootRef.current?.querySelector<HTMLElement>(CREATE_FAB)
          ?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
      }
    };

    const landWhenDone = (slide: Slide) => {
      const animation = slide.track;
      void animation.finished.then(() => {
        if (running.current === slide && slide.track === animation) land(slide);
      }, () => undefined);
    };

    const slideTo: DockTabSlideStore["slideTo"] = (target, commit, { create }) => {
      const track = trackRef.current;
      const root = rootRef.current;
      if (!track || !root || reducedMotion()) return false;
      const slide = running.current;
      if (slide) {
        if (target === slide.slot) return true;
        // Taken over where the page is, at the speed it has.
        const t = Number(slide.track.currentTime ?? 0) / 1000;
        const offset = slide.from - slide.to;
        const from = slide.to + springOffset(offset, slide.speed, t);
        const speed = springSpeed(offset, slide.speed, t);
        const to = (-target * track.getBoundingClientRect().width) / track.children.length;
        slide.track.cancel();
        Object.assign(slide, { slot: target, commit, from, to, speed, track: moveTrack(track, from, to, speed) });
        pending.set(target);
        landWhenDone(slide);
        return true;
      }
      const { slot: current, tabRootShowing: showing } = shown.current;
      // The tab's screen has to be on the track already; one not shown yet renders first.
      if (!showing || target === current || !track.children[target]?.firstElementChild) return false;
      const width = track.getBoundingClientRect().width / track.children.length;
      const from = -current * width;
      const to = -target * width;
      const direction = target > current ? 1 : -1;
      const duration = springDuration(from - to, 0);
      const timing = { duration: duration * 1000, easing: "linear", fill: "forwards" as const };
      const others: Animation[] = [];
      const bar = root.querySelector<HTMLElement>(TAB_ROOT_BAR);
      const copy = bar ? copyBar(bar) : null;
      if (bar) others.push(bar.animate(springFrames(0, -direction * 100, duration, percentX), timing));
      if (copy) others.push(copy.animate(springFrames(direction * 100, 0, duration, percentX), timing));
      // The + stays where it is when the new screen has one too; otherwise it leaves with its page.
      const fab = root.querySelector<HTMLElement>(CREATE_FAB);
      if (fab && !create) others.push(fab.animate(springFrames(0, -direction * width, duration, pixelX), timing));
      const started: Slide = {
        slot: target, commit, from, to, speed: 0, track: moveTrack(track, from, to, 0), others, copy,
        createArrives: !fab && create,
      };
      running.current = started;
      pending.set(target);
      landWhenDone(started);
      return true;
    };

    return { putAway, slideTo };
  }, [pending, rootRef]);

  useLayoutEffect(() => {
    const from = previousSlot.current;
    previousSlot.current = slot;
    if (from === slot || landing.current) return;
    // The app went to a tab by itself: that wins over a slide under way.
    if (running.current) controller.putAway(running.current);
    const track = trackRef.current;
    trackSlide.current?.cancel();
    trackSlide.current = null;
    if (track && !reducedMotion()) {
      const duration = springDuration(Math.abs(slot - from) * window.innerWidth, 0);
      const animation = track.animate(springFrames(from * -25, slot * -25, duration, (value) => `translate3d(${value}%, 0, 0)`),
        { duration: duration * 1000, easing: "linear" });
      trackSlide.current = animation;
      startAfterPaint([animation]);
    }
    const tapped = tabTapped.current;
    tabTapped.current = false;
    if (tapped && tabRootShowing) store.set({ key: performance.now(), direction: slot > from ? 1 : -1, span: Math.abs(slot - from) });
  }, [controller, slot, store, tabRootShowing, tabTapped]);

  useEffect(() => () => {
    if (running.current) controller.putAway(running.current);
  }, [controller]);

  return useMemo(() => ({ ...store, trackRef, pending, slideTo: controller.slideTo }), [controller, pending, store]);
}

/** Slides the bar in with the new tab's page and its copy out with the old one, as the track moves. */
export function slideDockTabBars(root: HTMLElement, slide: DockTabSlide): Animation | null {
  // Reduced motion leaves the track still; the bar does not move either.
  if (reducedMotion()) return null;
  const bar = root.querySelector<HTMLElement>(TAB_ROOT_BAR);
  const ghost = root.querySelector<HTMLElement>(".app-dock-tab-slide-outgoing");
  const duration = springDuration(slide.span * window.innerWidth, 0);
  const timing = { duration: duration * 1000, easing: "linear" };
  const arriving = bar?.animate(springFrames(slide.direction * 100, 0, duration, percentX), timing);
  const leaving = ghost?.animate(springFrames(0, -slide.direction * 100, duration, percentX),
    { ...timing, fill: "forwards" }) ?? null;
  // On the frame the track starts, held as it is (start-after-paint.ts).
  startAfterPaint([arriving, leaving]);
  return leaving;
}

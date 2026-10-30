"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { flushSync } from "react-dom";

import { useScreenChangeStore, type ScreenChangeStore } from "./screen-change-store";
import { systemBackLayerOpen } from "./use-system-back";

/*
 * A phone's conversation and its Space's channel list trade places without the
 * page moving: the bar, its wood sign and the controls at the bottom stay where
 * they are, and only the two lists slide, side by side as one strip. The sign
 * keeps its place too; the names slide through it. (Switching dock tabs moves
 * the whole page, sign included: use-dock-tab-slide.ts.)
 *
 * It has to keep up with a finger at 120 Hz, so:
 * - Everything that moves is its own compositor layer for the length of the
 *   change and moves by transform or opacity alone: a frame repaints nothing,
 *   lays out only the sign's length, and touches only those elements' own
 *   inline styles. Nothing the whole page inherits changes, and the shell does
 *   not render: the root's `data-list-transition` is set here, and only
 *   MobileListTransitionLayer draws the list's bar and controls.
 * - Once let go, the rest of the way is handed to the compositor as keyframes
 *   sampled from the spring, so it lands smoothly whatever the main thread does.
 * - The iOS app announces a touch at the left edge (`prepare`) before its swipe
 *   is recognized; the change is set up then, invisibly, and the swipe starts
 *   on a page that is ready. A swipe that catches the screen springing back
 *   carries on from where the screen is.
 */

/** `prepared`: set up and invisible, waiting for the swipe a touch at the edge may start. */
export type MobileListTransitionStage = "prepared" | "back" | "forward";

/** Which change is running, for the layer that draws the list's bar and controls during it. */
export type MobileListTransitionStore = ScreenChangeStore<MobileListTransitionStage>;

/** runMobileScreenTransition hands a screen change here first; true when it was drawn here. */
export type MobileListTransitionDriver = {
  run: (direction: "forward" | "back", update: () => void) => boolean;
};

declare global {
  interface Window {
    /** The iOS app's left-edge swipe, drawn by the page: a touch at the edge, begin, its distance as it moves, then whether it went Back. */
    __xmatrixBackGesture?: {
      prepare: () => void;
      begin: () => boolean;
      move: (distance: number) => void;
      end: (back: boolean, speed: number) => void;
    };
  }
}

/** Critically damped: no overshoot, settled in about 0.4 s. */
const SETTLE_RATE = 22;
/** Points sampled from the spring for the compositor's keyframes. */
const SETTLE_SAMPLES = 60;
/** A prepared change no swipe took up is put away. */
const PREPARED_FOR_MS = 700;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How far from its target the spring is `t` s after leaving `offset` px from it at `speed` px/s. */
function springOffset(offset: number, speed: number, t: number): number {
  return (offset + (speed + SETTLE_RATE * offset) * t) * Math.exp(-SETTLE_RATE * t);
}

/** When the spring is within half a pixel of its target for good. */
function springDuration(offset: number, speed: number): number {
  let settledAt = 0;
  for (let t = 0; t <= 1; t += 1 / 240) {
    if (Math.abs(springOffset(offset, speed, t)) >= 0.5) settledAt = t + 1 / 240;
  }
  return Math.max(settledAt, 0.12);
}

/** The elements that move during the change, found once when it is set up. */
type Parts = {
  width: number;
  list: HTMLElement | null;
  conversation: HTMLElement[];
  /** The conversation's rows and summary, which carry its paper while it moves. */
  conversationPaper: HTMLElement[];
  /** The conversation bar's paper, a layer of its own while it clears. */
  band: HTMLElement | null;
  sign: { from: number; to: number; boards: HTMLElement[]; leaving: HTMLElement[]; arriving: HTMLElement[] } | null;
  leavingGlyphs: HTMLElement[];
  arrivingGlyphs: HTMLElement[];
  composer: HTMLElement | null;
  composerParts: HTMLElement[];
  listControls: HTMLElement[];
};

type Pose = { transform?: string; opacity?: string; width?: string };

const all = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector));

function findParts(root: HTMLElement): Parts {
  const target = root.querySelector<HTMLElement>(".app-list-transition-target");
  const fromBoard = root.querySelector<HTMLElement>(".app-topbar:not(.app-list-transition-target) .app-mobile-back-sign");
  const toBoard = target?.querySelector<HTMLElement>(":is(.app-mobile-title, .app-mobile-space-trigger)") ?? null;
  // Both boards are on the page at their natural lengths now.
  const sign = fromBoard && toBoard ? {
    from: fromBoard.getBoundingClientRect().width,
    to: toBoard.getBoundingClientRect().width,
    boards: [fromBoard, toBoard],
    leaving: Array.from(fromBoard.children) as HTMLElement[],
    arriving: Array.from(toBoard.children) as HTMLElement[],
  } : null;
  return {
    width: root.clientWidth || window.innerWidth,
    list: root.querySelector<HTMLElement>(".app-mobile-dock-pager"),
    conversation: all(root, ".app-message-surface > :not(.app-composer)"),
    conversationPaper: all(root, ".app-message-surface > :not(.app-composer, .app-agent-work-dock)"),
    band: root.querySelector<HTMLElement>(".app-list-transition-band"),
    sign,
    leavingGlyphs: all(root, ".app-mobile-channel-detail-bar :is(.app-mobile-share-button, .app-mobile-channel-more-button)"),
    arrivingGlyphs: target ? all(target, ".app-mobile-search-icon") : [],
    composer: root.querySelector<HTMLElement>(".app-composer"),
    composerParts: all(root, ".app-composer-shell > *"),
    listControls: all(root, ".app-list-transition-controls :is(.app-mobile-create-fab, .app-mobile-tab-dock)"),
  };
}

/** Where everything stands `x` px along: 0 = the conversation, width = the list. */
function poses(parts: Parts, x: number): Array<[HTMLElement, Pose]> {
  const p = Math.min(1, Math.max(0, x / parts.width));
  const out: Array<[HTMLElement, Pose]> = [];
  const shift = (dx: number, dy = 0) => `translate3d(${dx}px, ${dy}px, 0)`;
  if (parts.list) out.push([parts.list, { transform: shift(x - parts.width) }]);
  for (const element of parts.conversation) out.push([element, { transform: shift(x) }]);
  if (parts.band) out.push([parts.band, { opacity: String(1 - p) }]);
  if (parts.sign) {
    const { from, to, boards, leaving, arriving } = parts.sign;
    for (const board of boards) out.push([board, { width: `${from + (to - from) * p}px` }]);
    for (const name of leaving) out.push([name, { transform: shift((from + 6) * p) }]);
    for (const name of arriving) out.push([name, { transform: shift((to + 6) * (p - 1)) }]);
  }
  for (const glyph of parts.leavingGlyphs) {
    out.push([glyph, { opacity: String(Math.max(0, 1 - 1.7 * p)), transform: shift(14 * p) }]);
  }
  for (const glyph of parts.arrivingGlyphs) {
    out.push([glyph, { opacity: String(Math.max(0, 1.7 * p - 0.7)), transform: shift(-14 * (1 - p)) }]);
  }
  if (parts.composer) out.push([parts.composer, { transform: shift(0, 8 * p) }]);
  // A glass fades on itself: faded through an ancestor it has nothing behind it to show.
  for (const part of parts.composerParts) out.push([part, { opacity: String(Math.max(0, 1 - 1.8 * p)) }]);
  for (const control of parts.listControls) {
    out.push([control, { opacity: String(Math.max(0, 1.8 * p - 0.8)), transform: shift(0, 8 * (1 - p)) }]);
  }
  return out;
}

function paint(parts: Parts, x: number) {
  for (const [element, pose] of poses(parts, x)) {
    for (const [property, value] of Object.entries(pose)) element.style.setProperty(property, value);
  }
}

/** What holds for the whole change, set once: the moving parts' own layers, and the conversation's paper. */
function setUp(parts: Parts) {
  for (const [element, pose] of poses(parts, 0)) {
    const layered = Object.keys(pose).filter((property) => property !== "width");
    if (layered.length) element.style.setProperty("will-change", layered.join(", "));
  }
  for (const element of parts.conversationPaper) element.style.setProperty("background", "var(--background)", "important");
  // Neither name shrinks to the board's changing length; the board covers what does not fit.
  for (const name of parts.sign ? [...parts.sign.leaving, ...parts.sign.arriving] : []) {
    name.style.setProperty("flex-shrink", "0", "important");
    name.style.setProperty("min-width", "max-content", "important");
  }
}

function tearDown(parts: Parts) {
  const elements = new Set([...poses(parts, 0).map(([element]) => element), ...parts.conversationPaper]);
  for (const element of elements) {
    for (const animation of element.getAnimations()) animation.cancel();
    for (const property of ["transform", "opacity", "width", "will-change", "background", "flex-shrink", "min-width"]) {
      element.style.removeProperty(property);
    }
  }
}

/** The rest of the way from `x` to `target`, on the compositor: keyframes sampled from the spring. */
function settleOnCompositor(parts: Parts, x: number, target: number, speed: number) {
  const offset = x - target;
  const duration = springDuration(offset, speed);
  const frames = Array.from({ length: SETTLE_SAMPLES + 1 }, (_, index) => {
    const t = (duration * index) / SETTLE_SAMPLES;
    return poses(parts, index === SETTLE_SAMPLES ? target : target + springOffset(offset, speed, t));
  });
  const animations = frames[0].map(([element], part) => element.animate(
    frames.map((pose) => ({ ...pose[part][1] })),
    { duration: duration * 1000, easing: "linear", fill: "forwards" },
  ));
  const startedAt = performance.now();
  return {
    animations,
    /** Where the screen is now, for a swipe that catches it. */
    position: () => target + springOffset(offset, speed, Math.min(duration, (performance.now() - startedAt) / 1000)),
  };
}

export function useMobileListTransition({ conversationOverList, listShowing, rootRef, driverRef, onBack }: {
  /** A conversation lies over its Space's channel list on a phone, with nothing open over it. */
  conversationOverList: boolean;
  /** The channel list is the screen, and opening a conversation would push it. */
  listShowing: boolean;
  rootRef: MutableRefObject<HTMLElement | null>;
  driverRef: MutableRefObject<MobileListTransitionDriver | null>;
  /** The conversation's Back to the channel list. */
  onBack: () => void;
}): MobileListTransitionStore {
  const state = useRef({ conversationOverList, listShowing, onBack });
  state.current = { conversationOverList, listShowing, onBack };
  const store = useScreenChangeStore<MobileListTransitionStage>();

  useEffect(() => {
    const m = {
      stage: null as MobileListTransitionStage | null,
      parts: null as Parts | null,
      x: 0,
      dragging: false,
      dragFrom: 0,
      committing: false,
      landing: null as null | { toList: boolean; position: () => number; animations: Animation[] },
      putAway: 0,
    };

    const stageAs = (stage: MobileListTransitionStage) => {
      m.stage = stage;
      if (rootRef.current) rootRef.current.dataset.listTransition = stage;
      // Only the layer renders: the list's bar and its controls, over the conversation's.
      flushSync(() => store.set(stage));
    };

    const setUpAs = (stage: MobileListTransitionStage): boolean => {
      const root = rootRef.current;
      if (!root) return false;
      // The bar's paper, read while it still paints it: the band takes it over.
      const bar = root.querySelector(".app-topbar.app-mobile-channel-detail-bar");
      const barPaper = bar ? getComputedStyle(bar).backgroundColor : "";
      stageAs(stage);
      m.parts = findParts(root);
      m.parts.band?.style.setProperty("background", barPaper);
      setUp(m.parts);
      m.x = stage === "forward" ? m.parts.width : 0;
      paint(m.parts, m.x);
      return true;
    };

    const close = (update?: () => void) => {
      window.clearTimeout(m.putAway);
      m.stage = null;
      m.dragging = false;
      m.landing = null;
      m.committing = Boolean(update);
      try {
        // The change lands in one render: the new screen, and the layer gone.
        flushSync(() => {
          update?.();
          store.set(null);
        });
      } finally {
        m.committing = false;
      }
      if (m.parts) tearDown(m.parts);
      m.parts = null;
      if (rootRef.current) delete rootRef.current.dataset.listTransition;
    };

    const land = (target: number, speed: number, then: () => void) => {
      const parts = m.parts;
      if (!parts) return;
      const landing = settleOnCompositor(parts, m.x, target, speed);
      m.landing = { toList: target > 0, ...landing };
      void Promise.all(landing.animations.map((animation) => animation.finished)).then(() => {
        if (m.landing?.animations !== landing.animations) return;
        m.x = target;
        then();
      }, () => undefined);
    };

    const canDrawBack = () => state.current.conversationOverList && !systemBackLayerOpen() && !reducedMotion();

    driverRef.current = {
      run(direction, update) {
        // The change lands under a finished drag, or under the native cover.
        if (m.committing) {
          update();
          return true;
        }
        if (reducedMotion()) return false;
        if (direction === "back") {
          if (m.stage === "prepared") {
            window.clearTimeout(m.putAway);
            stageAs("back");
          } else if (m.stage || !state.current.conversationOverList || !setUpAs("back")) {
            return false;
          }
          land(m.parts!.width, 0, () => close(update));
          return true;
        }
        if (m.stage === "prepared") close();
        if (m.stage || !state.current.listShowing) return false;
        flushSync(update);
        if (state.current.conversationOverList && setUpAs("forward")) land(0, 0, () => close());
        return true;
      },
    };

    const gesture: NonNullable<Window["__xmatrixBackGesture"]> = {
      prepare() {
        if (m.stage || !canDrawBack()) return;
        setUpAs("prepared");
        m.putAway = window.setTimeout(() => {
          if (m.stage === "prepared") close();
        }, PREPARED_FOR_MS);
      },
      begin() {
        if (m.landing) {
          // Springing back to the conversation: the finger catches it where it is.
          if (m.landing.toList) return true;
          const caughtAt = m.landing.position();
          for (const animation of m.landing.animations) animation.cancel();
          m.landing = null;
          m.dragging = true;
          m.dragFrom = caughtAt;
          m.x = caughtAt;
          if (m.parts) paint(m.parts, caughtAt);
          return true;
        }
        if (m.stage === "prepared") {
          window.clearTimeout(m.putAway);
          stageAs("back");
        } else if (m.stage || !canDrawBack() || !setUpAs("back")) {
          return false;
        }
        m.dragging = true;
        m.dragFrom = 0;
        return true;
      },
      move(distance) {
        if (!m.dragging || !m.parts) return;
        m.x = Math.max(0, m.dragFrom + distance);
        paint(m.parts, m.x);
      },
      end(back, speed) {
        if (!m.dragging || !m.parts) return;
        m.dragging = false;
        if (back) land(m.parts.width, speed, () => close(() => state.current.onBack()));
        else land(0, speed, () => close());
      },
    };
    window.__xmatrixBackGesture = gesture;

    return () => {
      window.clearTimeout(m.putAway);
      if (window.__xmatrixBackGesture === gesture) delete window.__xmatrixBackGesture;
      driverRef.current = null;
    };
  }, [driverRef, rootRef, store]);

  return store;
}

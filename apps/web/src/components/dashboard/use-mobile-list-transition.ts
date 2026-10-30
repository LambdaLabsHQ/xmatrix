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
 * A drag moves at the finger's rate, so a frame may touch only the few
 * elements that move, through their own inline styles. Anything the whole page
 * inherits (a custom property on the shell) would restyle every node on every
 * frame. For the same reason the shell does not re-render to start or end the
 * change: the root carries `data-list-transition` set here, globals.css draws
 * what holds for the whole change from it, and only MobileListTransitionLayer
 * renders the list's own bar and controls for it.
 */

export type MobileListTransitionStage = "back" | "forward";

/** Which change is running, for the layer that draws the list's bar and controls during it. */
export type MobileListTransitionStore = ScreenChangeStore<MobileListTransitionStage>;

/** runMobileScreenTransition hands a screen change here first; true when it was drawn here. */
export type MobileListTransitionDriver = {
  run: (direction: "forward" | "back", update: () => void) => boolean;
};

declare global {
  interface Window {
    /** The iOS app's left-edge swipe, drawn by the page: begin, its distance as it moves, then whether it went Back. */
    __xmatrixBackGesture?: {
      begin: () => boolean;
      move: (distance: number) => void;
      end: (back: boolean, speed: number) => void;
    };
  }
}

/** Critically damped: it settles in about 0.4 s and never overshoots. */
const SETTLE_RATE = 22;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The elements that move during the change, found once when it starts. */
type Parts = {
  width: number;
  list: HTMLElement | null;
  conversation: HTMLElement[];
  /** The conversation's rows and summary, which carry its paper while it moves. */
  conversationPaper: HTMLElement[];
  band: HTMLElement | null;
  sign: { from: number; to: number; boards: HTMLElement[]; leaving: HTMLElement[]; arriving: HTMLElement[] } | null;
  leavingGlyphs: HTMLElement[];
  arrivingGlyphs: HTMLElement[];
  composer: HTMLElement | null;
  composerParts: HTMLElement[];
  listControls: HTMLElement[];
};

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
    band: root.querySelector<HTMLElement>(".app-topbar.app-mobile-channel-detail-bar"),
    sign,
    leavingGlyphs: all(root, ".app-mobile-channel-detail-bar :is(.app-mobile-share-button, .app-mobile-channel-more-button)"),
    arrivingGlyphs: target ? all(target, ".app-mobile-search-icon") : [],
    composer: root.querySelector<HTMLElement>(".app-composer"),
    composerParts: all(root, ".app-composer-shell > *"),
    listControls: all(root, ".app-list-transition-controls :is(.app-mobile-create-fab, .app-mobile-tab-dock)"),
  };
}

const PAINTED = ["translate", "opacity", "width", "background", "flex-shrink", "min-width"] as const;

/** What holds for the whole change, set once on the elements it concerns. */
function prepare(parts: Parts) {
  for (const element of parts.conversationPaper) element.style.setProperty("background", "var(--background)", "important");
  // Neither name shrinks to the board's changing length; the board covers what does not fit.
  for (const name of parts.sign ? [...parts.sign.leaving, ...parts.sign.arriving] : []) {
    name.style.setProperty("flex-shrink", "0", "important");
    name.style.setProperty("min-width", "max-content", "important");
  }
}

/** One frame of the change, `x` px along (0 = the conversation, width = the list). */
function paint(parts: Parts, x: number) {
  const p = Math.min(1, Math.max(0, x / parts.width));
  const set = (element: HTMLElement | null, property: (typeof PAINTED)[number], value: string) =>
    element?.style.setProperty(property, value, "important");
  set(parts.list, "translate", `${x - parts.width}px 0`);
  for (const element of parts.conversation) set(element, "translate", `${x}px 0`);
  set(parts.band, "background", `color-mix(in oklch, var(--background) ${(1 - p) * 100}%, transparent)`);
  if (parts.sign) {
    const { from, to, boards, leaving, arriving } = parts.sign;
    for (const board of boards) set(board, "width", `${from + (to - from) * p}px`);
    for (const name of leaving) set(name, "translate", `${(from + 6) * p}px 0`);
    for (const name of arriving) set(name, "translate", `${(to + 6) * (p - 1)}px 0`);
  }
  for (const glyph of parts.leavingGlyphs) {
    set(glyph, "opacity", String(1 - 1.7 * p));
    set(glyph, "translate", `${14 * p}px 0`);
  }
  for (const glyph of parts.arrivingGlyphs) {
    set(glyph, "opacity", String(1.7 * p - 0.7));
    set(glyph, "translate", `${-14 * (1 - p)}px 0`);
  }
  set(parts.composer, "translate", `0 ${8 * p}px`);
  // A glass fades on itself: faded through an ancestor it has nothing behind it to show.
  for (const part of parts.composerParts) set(part, "opacity", String(1 - 1.8 * p));
  for (const control of parts.listControls) {
    set(control, "opacity", String(1.8 * p - 0.8));
    set(control, "translate", `0 ${8 * (1 - p)}px`);
  }
}

function unpaint(parts: Parts) {
  const elements = [parts.list, parts.band, parts.composer, ...parts.conversation, ...parts.conversationPaper, ...parts.leavingGlyphs,
    ...parts.arrivingGlyphs, ...parts.composerParts, ...parts.listControls,
    ...(parts.sign ? [...parts.sign.boards, ...parts.sign.leaving, ...parts.sign.arriving] : [])];
  for (const element of elements) {
    for (const property of PAINTED) element?.style.removeProperty(property);
  }
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
    const setStage = store.set;
    const m = { stage: null as MobileListTransitionStage | null, parts: null as Parts | null, x: 0, frame: 0,
      dragging: false, committing: false };

    const move = (x: number) => {
      m.x = x;
      if (m.parts) paint(m.parts, x);
    };

    const open = (direction: MobileListTransitionStage): boolean => {
      const root = rootRef.current;
      if (!root) return false;
      m.stage = direction;
      root.dataset.listTransition = direction;
      // Only the layer renders: the list's bar and its controls, over the conversation's.
      flushSync(() => setStage(direction));
      m.parts = findParts(root);
      prepare(m.parts);
      move(direction === "forward" ? m.parts.width : 0);
      return true;
    };

    const close = (update?: () => void) => {
      cancelAnimationFrame(m.frame);
      m.stage = null;
      m.dragging = false;
      m.committing = Boolean(update);
      try {
        // The change lands in one render: the new screen, and the layer gone.
        flushSync(() => {
          update?.();
          setStage(null);
        });
      } finally {
        m.committing = false;
      }
      if (m.parts) unpaint(m.parts);
      m.parts = null;
      if (rootRef.current) delete rootRef.current.dataset.listTransition;
    };

    /* From where it is to `target`, carrying `speed` (px/s). A release keeps
       the finger's speed from this instant; a change that has just rendered a
       screen starts from rest on its first frame, so the time that commit took
       is not drawn as a jump. Time is read when each frame runs: a frame's own
       timestamp can predate the long commit before it. */
    const settle = (target: number, speed: number, fromRelease: boolean, done: () => void) => {
      cancelAnimationFrame(m.frame);
      const offset = m.x - target;
      let start = fromRelease ? performance.now() : 0;
      const step = () => {
        const now = performance.now();
        if (!start) start = now;
        const t = (now - start) / 1000;
        const left = (offset + (speed + SETTLE_RATE * offset) * t) * Math.exp(-SETTLE_RATE * t);
        if (Math.abs(left) < 0.5 && t > 0.05) {
          move(target);
          done();
          return;
        }
        move(target + left);
        m.frame = requestAnimationFrame(step);
      };
      m.frame = requestAnimationFrame(step);
    };

    driverRef.current = {
      run(direction, update) {
        // The change lands under a finished drag, or under the native cover.
        if (m.committing) {
          update();
          return true;
        }
        if (m.stage || reducedMotion()) return false;
        if (direction === "back") {
          if (!state.current.conversationOverList || !open("back")) return false;
          settle(m.parts!.width, 0, false, () => close(update));
          return true;
        }
        if (!state.current.listShowing) return false;
        flushSync(update);
        if (state.current.conversationOverList && open("forward")) settle(0, 0, false, () => close());
        return true;
      },
    };

    const gesture: NonNullable<Window["__xmatrixBackGesture"]> = {
      begin() {
        if (m.stage || !state.current.conversationOverList || systemBackLayerOpen() || reducedMotion()) return false;
        if (!open("back")) return false;
        m.dragging = true;
        return true;
      },
      move(distance) {
        if (m.dragging) move(Math.max(0, distance));
      },
      end(back, speed) {
        if (!m.dragging || !m.parts) return;
        m.dragging = false;
        settle(back ? m.parts.width : 0, speed, true, () => back ? close(() => state.current.onBack()) : close());
      },
    };
    window.__xmatrixBackGesture = gesture;

    return () => {
      cancelAnimationFrame(m.frame);
      if (window.__xmatrixBackGesture === gesture) delete window.__xmatrixBackGesture;
      driverRef.current = null;
    };
  }, [driverRef, rootRef, store]);

  return store;
}

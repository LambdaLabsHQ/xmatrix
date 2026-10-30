"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { flushSync } from "react-dom";

import { systemBackLayerOpen } from "./use-system-back";

/*
 * A phone's conversation and its Space's channel list trade places without the
 * page moving: the bar, its wood sign and the controls at the bottom stay where
 * they are, and only the two lists slide, side by side as one strip. The sign
 * keeps its place too; the names slide through it. (Switching dock tabs moves
 * the whole page, sign included: use-dock-tab-slide.ts.)
 *
 * The shell root carries the motion as custom properties, written directly so
 * a finger's drag never re-renders React:
 *   --app-list-dx           how far the conversation has moved right (px)
 *   --app-list-p            the same as a fraction of the width, 0..1
 *   --app-list-sign-from/to the sign's width as the conversation and as the list
 * globals.css draws every layer from them.
 */

export type MobileListTransitionStage = "back" | "forward";

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

export function useMobileListTransition({ conversationOverList, listShowing, rootRef, driverRef, onBack }: {
  /** A conversation lies over its Space's channel list on a phone, with nothing open over it. */
  conversationOverList: boolean;
  /** The channel list is the screen, and opening a conversation would push it. */
  listShowing: boolean;
  rootRef: MutableRefObject<HTMLElement | null>;
  driverRef: MutableRefObject<MobileListTransitionDriver | null>;
  /** The conversation's Back to the channel list. */
  onBack: () => void;
}): MobileListTransitionStage | null {
  const [stage, setStage] = useState<MobileListTransitionStage | null>(null);
  const state = useRef({ conversationOverList, listShowing, onBack });
  state.current = { conversationOverList, listShowing, onBack };
  const motion = useRef({ stage: null as MobileListTransitionStage | null, x: 0, width: 0, frame: 0, dragging: false,
    committing: false });

  useEffect(() => {
    const m = motion.current;

    const paint = (x: number) => {
      const root = rootRef.current;
      if (!root) return;
      m.x = x;
      root.style.setProperty("--app-list-dx", `${x}px`);
      root.style.setProperty("--app-list-p", String(Math.min(1, Math.max(0, x / m.width))));
    };

    const open = (direction: MobileListTransitionStage): boolean => {
      const root = rootRef.current;
      if (!root) return false;
      m.stage = direction;
      m.width = root.clientWidth || window.innerWidth;
      flushSync(() => setStage(direction));
      // Both signs are on the page now at their natural widths; the board
      // takes the conversation's and the list's in turn.
      const from = root.querySelector(".app-topbar:not(.app-list-transition-target) .app-mobile-back-sign");
      const to = root.querySelector(".app-list-transition-target :is(.app-mobile-title, .app-mobile-space-trigger)");
      root.style.setProperty("--app-list-sign-from", `${from?.getBoundingClientRect().width ?? 0}px`);
      root.style.setProperty("--app-list-sign-to", `${to?.getBoundingClientRect().width ?? 0}px`);
      root.dataset.listTransitionSized = "";
      paint(direction === "forward" ? m.width : 0);
      return true;
    };

    const close = (update?: () => void) => {
      cancelAnimationFrame(m.frame);
      m.stage = null;
      m.dragging = false;
      m.committing = Boolean(update);
      try {
        flushSync(() => {
          update?.();
          setStage(null);
        });
      } finally {
        m.committing = false;
      }
      const root = rootRef.current;
      if (!root) return;
      for (const name of ["--app-list-dx", "--app-list-p", "--app-list-sign-from", "--app-list-sign-to"]) {
        root.style.removeProperty(name);
      }
      delete root.dataset.listTransitionSized;
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
          paint(target);
          done();
          return;
        }
        paint(target + left);
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
          settle(m.width, 0, false, () => close(update));
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
        if (m.dragging) paint(Math.max(0, distance));
      },
      end(back, speed) {
        if (!m.dragging) return;
        m.dragging = false;
        settle(back ? m.width : 0, speed, true, () => back ? close(() => state.current.onBack()) : close());
      },
    };
    window.__xmatrixBackGesture = gesture;

    return () => {
      cancelAnimationFrame(m.frame);
      if (window.__xmatrixBackGesture === gesture) delete window.__xmatrixBackGesture;
      driverRef.current = null;
    };
  }, [driverRef, rootRef]);

  return stage;
}

"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { observeAnimationVisibility } from "./animation-visibility";

const AnimationActivity = createContext(true);

/** The component that makes a mounted pane inert also suspends its clocks. */
export function AnimationActivityScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(AnimationActivity);
  return <AnimationActivity value={active && parentActive}>{children}</AnimationActivity>;
}

type DecorationClock = Pick<Animation, "playState" | "play" | "pause" | "cancel">;
type ClockFactory = (element: HTMLElement) => DecorationClock | undefined;
type VisibilityTarget = (element: HTMLElement) => { element: HTMLElement; root?: Element | Document | null };
type Decoration = {
  element: HTMLElement;
  root?: Element | Document | null;
  createClock: () => DecorationClock | undefined;
  active: boolean;
  visible: boolean;
  animation?: DecorationClock;
};

const decorations = new Set<Decoration>();
let reducedMotion: MediaQueryList | undefined;

function synchronize(decoration: Decoration) {
  if (reducedMotion?.matches) {
    decoration.animation?.cancel();
    decoration.animation = undefined;
    return;
  }
  if (!decoration.active || !decoration.visible) {
    decoration.animation?.pause();
    return;
  }
  if (!decoration.animation) decoration.animation = decoration.createClock();
  else if (decoration.animation.playState !== "running") decoration.animation.play();
}

function onMotionChange() {
  for (const decoration of decorations) synchronize(decoration);
}

function registerDecoration(decoration: Decoration) {
  if (!reducedMotion) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", onMotionChange);
  }
  decorations.add(decoration);
  const unobserve = observeAnimationVisibility(decoration.element, (visible) => {
    decoration.visible = visible;
    synchronize(decoration);
  }, decoration.root);
  return () => {
    unobserve?.();
    decoration.animation?.cancel();
    decorations.delete(decoration);
    if (!decorations.size) {
      reducedMotion?.removeEventListener("change", onMotionChange);
      reducedMotion = undefined;
    }
  };
}

function useDecorationClock(createClock: ClockFactory, enabled: boolean, visibilityTarget?: VisibilityTarget) {
  const active = useContext(AnimationActivity);
  const activeRef = useRef(active);
  const decorationRef = useRef<Decoration | undefined>(undefined);
  useLayoutEffect(() => {
    activeRef.current = active;
    const decoration = decorationRef.current;
    if (decoration) {
      decoration.active = active;
      synchronize(decoration);
    }
  }, [active]);
  return useCallback((element: HTMLElement | null) => {
    if (!element || !enabled || typeof element.animate !== "function") return;
    const target = visibilityTarget?.(element) ?? { element };
    const decoration: Decoration = { ...target, createClock: () => createClock(element), active: activeRef.current, visible: false };
    decorationRef.current = decoration;
    const unregister = registerDecoration(decoration);
    return () => {
      unregister();
      if (decorationRef.current === decoration) decorationRef.current = undefined;
    };
  }, [createClock, enabled, visibilityTarget]);
}

/** Ordinary Web Animations keep these compositor clocks independent of CSS
 * iteration events. Visibility and pane activity pause without losing phase;
 * reduced motion cancels the effect and restores the static CSS appearance. */
export function useDecorationSpin(enabled = true) {
  const createClock = useCallback((element: HTMLElement) => element.animate(
    [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
    { duration: 1600, iterations: Infinity, easing: "linear" },
  ), []);
  return useDecorationClock(createClock, enabled);
}

/** All effects share one document clock at playbackRate 1. A synchronous
 * currentTime assignment completes a pending pause, so neither member can
 * retain a different held time or finish an old async continuation later. */
function createSynchronizedClock(effects: readonly KeyframeEffect[]): DecorationClock | undefined {
  if (!effects.length || typeof document.timeline.currentTime !== "number") return;
  const animations = effects.map(effect => new Animation(effect, document.timeline));
  let heldTime = 0;
  let state: AnimationPlayState = "paused";
  const clock: DecorationClock = {
    get playState() { return state; },
    play() {
      if (state === "running") return;
      const now = document.timeline.currentTime;
      if (typeof now !== "number") return;
      const startTime = now - heldTime;
      for (const animation of animations) {
        animation.currentTime = heldTime;
        animation.play();
        animation.startTime = startTime;
      }
      state = "running";
    },
    pause() {
      if (state !== "running") return;
      const current = animations[0]!.currentTime;
      if (typeof current === "number") heldTime = current;
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = heldTime;
      }
      state = "paused";
    },
    cancel() {
      for (const animation of animations) animation.cancel();
      state = "idle";
    },
  };
  clock.play();
  return clock;
}

/** One owner keeps related effects in phase. Factories and visibility-target
 * resolvers must be stable: updating text must not recreate their clocks. */
export function useDecorationAnimationGroup(
  createEffects: (element: HTMLElement) => readonly KeyframeEffect[],
  enabled = true,
  visibilityTarget?: VisibilityTarget,
) {
  const createClock = useCallback((element: HTMLElement) => createSynchronizedClock(createEffects(element)), [createEffects]);
  return useDecorationClock(createClock, enabled, visibilityTarget);
}

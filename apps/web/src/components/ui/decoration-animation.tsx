"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { observeAnimationVisibility } from "./animation-visibility";

const AnimationActivity = createContext(true);

/** The component that makes a mounted pane inert also suspends its clocks. */
export function AnimationActivityScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(AnimationActivity);
  return <AnimationActivity value={active && parentActive}>{children}</AnimationActivity>;
}

type DecorationKind = "pulse" | "spin";
type Decoration = {
  element: HTMLElement;
  kind: DecorationKind;
  active: boolean;
  visible: boolean;
  animation?: Animation;
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
  if (!decoration.animation) {
    // Pulse's easing belongs to each half, as in the CSS keyframes. Applying
    // it once to the whole iteration would change the painted rhythm.
    const pulse = decoration.kind === "pulse";
    decoration.animation = decoration.element.animate(pulse ? [
      { opacity: 1, offset: 0, easing: "cubic-bezier(0.4, 0, 0.6, 1)" },
      { opacity: 0.5, offset: 0.5, easing: "cubic-bezier(0.4, 0, 0.6, 1)" },
      { opacity: 1, offset: 1 },
    ] : [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: pulse ? 2000 : 1600,
      iterations: Infinity,
      easing: "linear",
    });
  } else if (decoration.animation.playState !== "running") {
    decoration.animation.play();
  }
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
  });
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

/** Ordinary Web Animations keep these compositor clocks independent of CSS
 * iteration events. Visibility and pane activity pause without losing phase;
 * reduced motion cancels the effect and restores the static CSS appearance. */
export function useDecorationAnimation(kind: DecorationKind, enabled = true) {
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
    const decoration: Decoration = { element, kind, active: activeRef.current, visible: false };
    decorationRef.current = decoration;
    const unregister = registerDecoration(decoration);
    return () => {
      unregister();
      if (decorationRef.current === decoration) decorationRef.current = undefined;
    };
  }, [kind, enabled]);
}

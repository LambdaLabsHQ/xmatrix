"use client";

import { useCallback, useRef } from "react";
import {
  WEB_PROXY_ROUTES, type OnboardingDevice, type OnboardingFunnelEvent, type OnboardingFunnelStep, type OnboardingSurface,
} from "@xmatrix/protocol";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";

/** What the person is looking at the step on, when it happens. A phone is the
 * shell's own breakpoint (useIsMobileViewport). */
export function onboardingDevice(): OnboardingDevice {
  if (getDesktopBridge()) return "desktop_app";
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? "phone" : "desktop_web";
}

/** Counts one step of bringing agents in (docs/architecture/first-space.md).
 * Nothing waits on it, and a step that goes uncounted changes nothing the
 * person sees. */
export function recordOnboardingStep(token: string | null | undefined, event: Omit<OnboardingFunnelEvent, "device">): void {
  if (!token) return;
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.observable_onboarding_step, token, method: "POST",
    body: { ...event, device: onboardingDevice() } })
    .catch((error: unknown) => console.warn("[xmatrix] onboarding step not counted", error));
}

/** Each step once per showing: a re-render, or the same step again, adds nothing. */
export function useOnboardingSteps(token: string | null | undefined, surface: OnboardingSurface) {
  const counted = useRef(new Set<OnboardingFunnelStep>());
  return useCallback((step: Exclude<OnboardingFunnelStep, "starter_chosen">) => {
    if (!token || counted.current.has(step)) return;
    counted.current.add(step);
    recordOnboardingStep(token, { step, surface });
  }, [token, surface]);
}

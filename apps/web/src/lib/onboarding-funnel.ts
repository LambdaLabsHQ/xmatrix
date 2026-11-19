"use client";

import { useCallback, useRef } from "react";
import {
  WEB_PROXY_ROUTES, type OnboardingDevice, type OnboardingFunnelEvent, type OnboardingFunnelStep, type OnboardingSurface,
} from "@xmatrix/protocol";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";

export interface OnboardingDeviceEnvironment {
  bridge?: { client?: string; platform?: string } | null;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  narrowViewport?: boolean;
  coarsePointer?: boolean;
}

/**
 * What the person is looking at the step on, when it happens.
 * iOS and Android native shells inject `window.xmatrixDesktop` too, so check
 * their bridge identity before calling it `desktop_app`. A narrow desktop
 * browser window (split screen on macOS/Windows/Linux with a fine pointer)
 * stays `desktop_web` so it still offers the desktop App and setup command.
 */
export function classifyOnboardingDevice(env: OnboardingDeviceEnvironment): OnboardingDevice {
  const bridge = env.bridge;
  if (bridge) {
    const client = String(bridge.client ?? "").toLowerCase();
    const platform = String(bridge.platform ?? "").toLowerCase();
    if (client === "ios" || client === "android" || platform === "ios" || platform === "android") {
      return "phone";
    }
    return "desktop_app";
  }
  const ua = env.userAgent ?? "";
  const maxTouchPoints = env.maxTouchPoints ?? 0;
  if (/iPhone|iPad|iPod|Android/iu.test(ua) || (env.platform === "MacIntel" && maxTouchPoints > 1)) {
    return "phone";
  }
  // Touch-screen Windows laptops (e.g. Surface) report maxTouchPoints > 0 even
  // in desktop mode; desktop OS UAs stay desktop_web in narrow windows too.
  if (/Windows|Macintosh|Mac OS X/iu.test(ua)) {
    return "desktop_web";
  }
  if (env.narrowViewport && env.coarsePointer) {
    return "phone";
  }
  return "desktop_web";
}

export function onboardingDevice(): OnboardingDevice {
  const win = typeof window === "undefined" ? undefined : window;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return classifyOnboardingDevice({
    bridge: getDesktopBridge(),
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
    narrowViewport: win?.matchMedia?.("(max-width: 767px)").matches ?? false,
    coarsePointer: win?.matchMedia?.("(pointer: coarse)").matches ?? false,
  });
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

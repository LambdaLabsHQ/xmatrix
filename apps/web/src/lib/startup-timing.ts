"use client";

import {
  STARTUP_TIMING_MAX_MS, WEB_PROXY_ROUTES, type StartupCache, type StartupTimingReport, type StartupTimingStage,
} from "@xmatrix/protocol";
import { onboardingDevice } from "@/lib/onboarding-funnel";
import { xmatrixApiRequest } from "@/lib/query/api-client";

/**
 * When this page load first reached each stage of opening the app, in ms
 * since navigation started (docs/performance/channel-startup.md). Only the
 * first time counts: a later account switch or re-render is not a start.
 */
/** After the list lands, how long a start may still reach its messages before it is sent. */
export const STARTUP_REPORT_SETTLE_MS = 5_000;

const reached: Partial<Record<StartupTimingStage, number>> = {};
let reported = false;

export function markStartup(stage: StartupTimingStage): void {
  if (reached[stage] !== undefined || typeof performance === "undefined") return;
  const ms = performance.now();
  if (ms <= STARTUP_TIMING_MAX_MS) reached[stage] = ms;
}

/** Sends this load's start once. Nothing waits on it; an uncounted start changes nothing on screen. */
export function reportStartupTiming(token: string | null | undefined, cache: StartupCache): void {
  if (reported || !token) return;
  reported = true;
  const report: StartupTimingReport = { device: onboardingDevice(), cache, ...reached };
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.observable_startup_timing, token, method: "POST", body: report })
    .catch((error: unknown) => console.warn("[xmatrix] startup timing not counted", error));
}

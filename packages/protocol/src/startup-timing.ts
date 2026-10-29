import { isOneOf, ONBOARDING_DEVICES, type OnboardingDevice } from "./onboarding-funnel.js";

/**
 * How long one app start took for the person, in milliseconds since the
 * page's navigation started (docs/performance/channel-startup.md). A stage the
 * start never reached is absent. Nothing names the person's data.
 */
export const STARTUP_TIMING_STAGES = ["shell", "signedIn", "list", "messages"] as const;
export type StartupTimingStage = typeof STARTUP_TIMING_STAGES[number];

/** Whether this device painted its last list before the session was confirmed. */
export const STARTUP_CACHES = ["warm", "cold"] as const;
export type StartupCache = typeof STARTUP_CACHES[number];

export type StartupTimingReport = {
  device: OnboardingDevice;
  cache: StartupCache;
} & Partial<Record<StartupTimingStage, number>>;

/** Longest stage time a report may carry: a start slower than this is reported as this. */
export const STARTUP_TIMING_MAX_MS = 120_000;

/** One start as a client reports it; anything else is not counted. */
export function parseStartupTimingReport(value: unknown): StartupTimingReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).some((key) => key !== "device" && key !== "cache" && !isOneOf(STARTUP_TIMING_STAGES, key)) ||
      !isOneOf(ONBOARDING_DEVICES, report.device) || !isOneOf(STARTUP_CACHES, report.cache)) return undefined;
  const parsed: StartupTimingReport = { device: report.device, cache: report.cache };
  for (const stage of STARTUP_TIMING_STAGES) {
    const ms = report[stage];
    if (ms === undefined) continue;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > STARTUP_TIMING_MAX_MS) return undefined;
    parsed[stage] = Math.round(ms);
  }
  return parsed;
}

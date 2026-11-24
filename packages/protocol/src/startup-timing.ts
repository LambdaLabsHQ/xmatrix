import { parseDiagnosticEvent, type DiagnosticEventSchema } from "./diagnostic-events.js";
import { ONBOARDING_DEVICES, type OnboardingDevice } from "./onboarding-funnel.js";

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

/** The declared fields of one app start (src/diagnostic-events.ts). */
const STARTUP_TIMING_EVENT = {
  device: { kind: "enum", values: ONBOARDING_DEVICES },
  cache: { kind: "enum", values: STARTUP_CACHES },
  ...Object.fromEntries(STARTUP_TIMING_STAGES.map((stage) =>
    [stage, { kind: "number", min: 0, max: STARTUP_TIMING_MAX_MS, optional: true } as const])) as
    Record<StartupTimingStage, { kind: "number"; min: 0; max: typeof STARTUP_TIMING_MAX_MS; optional: true }>,
} as const satisfies DiagnosticEventSchema;

/** One start as a client reports it; anything else is not counted. */
export function parseStartupTimingReport(value: unknown): StartupTimingReport | undefined {
  const report = parseDiagnosticEvent(STARTUP_TIMING_EVENT, value);
  if (!report) return undefined;
  const parsed: StartupTimingReport = { device: report.device, cache: report.cache };
  for (const stage of STARTUP_TIMING_STAGES) {
    const ms = report[stage];
    if (ms !== undefined) parsed[stage] = Math.round(ms);
  }
  return parsed;
}

import type { Env } from "./types";

export function sampledAnalyticsPoint(rate: number): boolean {
  return rate === 1 || Math.random() * rate < 1;
}

export function analyticsWorkerVersion(env: Pick<Env, "CF_VERSION_METADATA">): string {
  return env.CF_VERSION_METADATA?.id?.trim().slice(0, 40) || "unknown";
}

/** Analytics durations discard invalid and negative measurements. */
export function analyticsPointDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

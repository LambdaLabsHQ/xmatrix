import type { Env } from "./types";

export function sampledAnalyticsPoint(rate: number): boolean {
  if (rate === 1) return true;
  const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return value % rate === 0;
}

export function analyticsWorkerVersion(env: Pick<Env, "CF_VERSION_METADATA">): string {
  return env.CF_VERSION_METADATA?.id?.trim().slice(0, 40) || "unknown";
}

/** Analytics durations discard invalid and negative measurements. */
export function analyticsPointDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

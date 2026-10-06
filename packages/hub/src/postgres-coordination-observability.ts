import { analyticsPointDuration as duration } from "./analytics-sampling";
import { sampledAnalyticsPoint as sampled, analyticsWorkerVersion as version } from "./analytics-sampling";
import type { Env } from "./types";

export const POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA =
  "postgres_coordination_observability_v1";

const DEFAULT_SAMPLE_RATE = 10;
const DEFAULT_SLOW_MS = 1_000;
const MAX_SAMPLE_RATE = 10_000;
const ERROR_CODE = /^[0-9A-Z_:-]{1,64}$/u;

export interface MessageCoordinationDurations {
  routeMs: number;
  prepareMs: number;
  reserveMs: number;
  encodeMs: number;
  appendMs: number;
  confirmMs: number;
  totalMs: number;
}

function boundedInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (!raw || !/^\d+$/u.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}



function safeErrorCode(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase();
  return normalized && ERROR_CODE.test(normalized) ? normalized : "NONE";
}


function write(env: Env, point: AnalyticsEngineDataPoint): void {
  if (env.RELAY_AUTHORITY_OBSERVABILITY_ENABLED !== "true") return;
  try {
    env.RELAY_AUTHORITY_OBSERVABILITY_AE?.writeDataPoint(point);
  } catch {
    // Coordination observation is derived state and cannot affect a request.
  }
}

/** One privacy-safe point preserves every phase from a sampled append request. */
export function recordMessageCoordination(input: {
  env: Env;
  outcome: "ok" | "error";
  errorCode?: string;
  durations: MessageCoordinationDurations;
}): boolean {
  const rate = boundedInteger(
    input.env.POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE,
    DEFAULT_SAMPLE_RATE,
    MAX_SAMPLE_RATE,
  );
  const slowMs = boundedInteger(
    input.env.RELAY_AUTHORITY_OBSERVABILITY_SLOW_MS,
    DEFAULT_SLOW_MS,
    60_000,
  );
  const slow = input.durations.totalMs >= slowMs;
  if (input.outcome === "ok" && !slow && !sampled(rate)) return false;
  write(input.env, {
    indexes: [POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA],
    blobs: [
      "message_append", input.outcome, safeErrorCode(input.errorCode), version(input.env),
      slow ? "slow" : input.outcome === "error" ? "error" : "sampled",
    ],
    doubles: [
      duration(input.durations.routeMs), duration(input.durations.prepareMs),
      duration(input.durations.reserveMs), duration(input.durations.encodeMs),
      duration(input.durations.appendMs), duration(input.durations.confirmMs),
      duration(input.durations.totalMs), input.outcome === "ok" && !slow ? rate : 1,
    ],
  });
  return true;
}

export function recordChannelReservationCleanup(input: {
  env: Env;
  outcome: "ok" | "error";
  deleted: number;
  remaining: number;
  oldestAgeMs: number;
  durationMs: number;
}): void {
  write(input.env, {
    indexes: [POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA],
    blobs: ["channel_reservation_cleanup", input.outcome, "none", version(input.env), "all"],
    doubles: [
      duration(input.deleted), duration(input.remaining), duration(input.oldestAgeMs),
      duration(input.durationMs), 1,
    ],
  });
}

export function recordAgentLaunchCoordinator(input: {
  env: Env;
  outcome: "ok" | "error";
  preparedToWakeMs: number;
  wakeToClaimMs: number;
  claimBatchSize: number;
  eligibleCount: number;
  oldestEligibleAgeMs: number;
  maintainMs: number;
}): void {
  write(input.env, {
    indexes: [POSTGRES_COORDINATION_OBSERVABILITY_SCHEMA],
    blobs: ["agent_launch_maintain", input.outcome, "none", version(input.env), "all"],
    doubles: [
      duration(input.preparedToWakeMs), duration(input.wakeToClaimMs),
      duration(input.claimBatchSize), duration(input.eligibleCount),
      duration(input.oldestEligibleAgeMs), duration(input.maintainMs), 1,
    ],
  });
}

export function logSlowMessageCoordination(input: {
  outcome: "ok" | "error";
  commandId: string;
  spaceId?: string;
  channelId: string;
  errorCode?: string;
  durations: MessageCoordinationDurations;
}): void {
  if (input.outcome === "ok" && input.durations.totalMs < DEFAULT_SLOW_MS) return;
  const fields = {
    outcome: input.outcome,
    commandId: input.commandId,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    channelId: input.channelId,
    errorCode: safeErrorCode(input.errorCode),
    durations: Object.fromEntries(Object.entries(input.durations).map(
      ([key, value]) => [key, Math.round(duration(value))],
    )),
  };
  if (input.outcome === "error") console.warn("PostgreSQL message append coordination failed", fields);
  else console.log("PostgreSQL message append coordination was slow", fields);
}

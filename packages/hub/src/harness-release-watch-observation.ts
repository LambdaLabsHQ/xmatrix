import { analyticsPointDuration, analyticsWorkerVersion } from "./analytics-sampling";
import type { Env } from "./types";

export type HarnessWatchObservationEnv = Pick<Env, "RELAY_AUTHORITY_OBSERVABILITY_AE" |
  "RELAY_AUTHORITY_OBSERVABILITY_ENABLED" | "CF_VERSION_METADATA">;

type WatchStage = "started" | "registry_read" | "target_read" | "notice_issue" | "close" |
  "completed" | "deferred" | "failed";

/** Checkpoints survive an uncatchable cell reset without recording any target or content. */
export function observeHarnessWatch(env: HarnessWatchObservationEnv, side: "cron" | "runtime",
  stage: WatchStage, started: number, issued = 0): void {
  if (env.RELAY_AUTHORITY_OBSERVABILITY_ENABLED !== "true") return;
  try {
    env.RELAY_AUTHORITY_OBSERVABILITY_AE?.writeDataPoint({
      indexes: ["harness_release_watch_v1"],
      blobs: [side, stage, analyticsWorkerVersion(env)],
      doubles: [analyticsPointDuration(Date.now() - started), Number.isSafeInteger(issued) && issued > 0 ? issued : 0],
    });
  } catch {
    // Telemetry must not replace a failure or interrupt notice issuance.
  }
}

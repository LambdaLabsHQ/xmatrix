import type { Env } from "./types";
import type { ChannelCatalogTimeoutBoundary } from "./channel-catalog-deadline";

export const CHANNEL_CATALOG_OBSERVABILITY_SCHEMA =
  "channel_catalog_observability_v3" as const;

export type ChannelCatalogOutcome = "ok" | "client_error" | "server_error";

/**
 * One request-local accumulator. It contains timings and bounded counts only;
 * no principal, Space, Channel, route, or request identity may enter it.
 */
export interface ChannelCatalogReadMetrics {
  catalogSyncMode: "complete" | "incremental" | "fallback";
  timeoutBoundary: ChannelCatalogTimeoutBoundary;
  directoryWallMs: number;
  revisionProbeWallMs: number;
  authorityCatalogWallMs: number;
  projectionWallMs: number;
  runtimePresenceWallMs: number;
  spaceCatalogReads: number;
  authorityCatalogPages: number;
  projectionReads: number;
  revisionProbes: number;
  replacedSpaces: number;
  removedSpaces: number;
}

export function createChannelCatalogReadMetrics(): ChannelCatalogReadMetrics {
  return {
    catalogSyncMode: "complete",
    timeoutBoundary: "none",
    directoryWallMs: 0,
    revisionProbeWallMs: 0,
    authorityCatalogWallMs: 0,
    projectionWallMs: 0,
    runtimePresenceWallMs: 0,
    spaceCatalogReads: 0,
    authorityCatalogPages: 0,
    projectionReads: 0,
    revisionProbes: 0,
    replacedSpaces: 0,
    removedSpaces: 0,
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Emit one low-cardinality point per authenticated catalog request. Phase wall
 * times for concurrent Space reads are accumulated work-time, while totalWallMs
 * remains the user-visible critical path. Keeping both makes fan-out waiting
 * distinguishable from CPU-heavy single-authority work without recording ids.
 */
export function recordChannelCatalogObservation(
  env: Pick<
    Env,
    "RELAY_AUTHORITY_OBSERVABILITY_AE" | "RELAY_AUTHORITY_OBSERVABILITY_ENABLED" |
      "CF_VERSION_METADATA"
  >,
  input: {
    outcome: ChannelCatalogOutcome;
    totalWallMs: number;
    channelCount: number;
    metrics: ChannelCatalogReadMetrics;
  },
): void {
  const dataset = env.RELAY_AUTHORITY_OBSERVABILITY_AE;
  if (!dataset || env.RELAY_AUTHORITY_OBSERVABILITY_ENABLED !== "true") return;
  const outcome: ChannelCatalogOutcome =
    input.outcome === "ok" || input.outcome === "client_error"
      ? input.outcome
      : "server_error";
  const version = env.CF_VERSION_METADATA?.id?.trim().slice(0, 40) || "unknown";
  try {
    dataset.writeDataPoint({
      indexes: [CHANNEL_CATALOG_OBSERVABILITY_SCHEMA],
      blobs: [outcome, version, input.metrics.catalogSyncMode, input.metrics.timeoutBoundary],
      doubles: [
        finiteNonNegative(input.totalWallMs),
        finiteNonNegative(input.metrics.directoryWallMs),
        finiteNonNegative(input.metrics.revisionProbeWallMs),
        finiteNonNegative(input.metrics.authorityCatalogWallMs),
        finiteNonNegative(input.metrics.projectionWallMs),
        finiteNonNegative(input.metrics.runtimePresenceWallMs),
        count(input.metrics.spaceCatalogReads),
        count(input.metrics.authorityCatalogPages),
        count(input.metrics.projectionReads),
        count(input.metrics.revisionProbes),
        count(input.metrics.replacedSpaces),
        count(input.metrics.removedSpaces),
        count(input.channelCount),
      ],
    });
  } catch {
    // Observation is never product authority and cannot fail a catalog read.
  }
}

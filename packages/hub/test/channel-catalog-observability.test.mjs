import { observabilitySink } from "./support/observability.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHANNEL_CATALOG_OBSERVABILITY_SCHEMA,
  createChannelCatalogReadMetrics,
  recordChannelCatalogObservation,
} from "../src/channel-catalog-observability.ts";

function sink(overrides) {
  return observabilitySink({ CF_VERSION_METADATA: { id: "catalog-version" } }, overrides);
}

test("catalog observation uses fixed slots without product identity", () => {
  const { env, written } = sink();
  const metrics = createChannelCatalogReadMetrics();
  Object.assign(metrics, {
    catalogSyncMode: "incremental",
    timeoutBoundary: "authority_page",
    directoryWallMs: 11,
    revisionProbeWallMs: 9,
    authorityCatalogWallMs: 120,
    projectionWallMs: 80,
    runtimePresenceWallMs: 17,
    spaceCatalogReads: 9,
    authorityCatalogPages: 12,
    projectionReads: 10,
    revisionProbes: 9,
    replacedSpaces: 2,
    removedSpaces: 1,
  });
  recordChannelCatalogObservation(env, {
    outcome: "ok",
    totalWallMs: 240,
    channelCount: 951,
    metrics,
  });
  assert.deepEqual(written, [{
    indexes: [CHANNEL_CATALOG_OBSERVABILITY_SCHEMA],
    blobs: ["ok", "catalog-version", "incremental", "authority_page"],
    doubles: [240, 11, 9, 120, 80, 17, 9, 12, 10, 9, 2, 1, 951],
  }]);
});

test("catalog observation neutralizes invalid values and dimensions", () => {
  const { env, written } = sink({ CF_VERSION_METADATA: undefined });
  const metrics = createChannelCatalogReadMetrics();
  metrics.directoryWallMs = Number.POSITIVE_INFINITY;
  metrics.spaceCatalogReads = -1;
  recordChannelCatalogObservation(env, {
    outcome: "not-an-outcome",
    totalWallMs: Number.NaN,
    channelCount: 1.5,
    metrics,
  });
  assert.deepEqual(written[0], {
    indexes: [CHANNEL_CATALOG_OBSERVABILITY_SCHEMA],
    blobs: ["server_error", "unknown", "complete", "none"],
    doubles: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
});

test("catalog observation is gated and best effort", () => {
  const disabled = sink({ RELAY_AUTHORITY_OBSERVABILITY_ENABLED: "false" });
  recordChannelCatalogObservation(disabled.env, {
    outcome: "ok",
    totalWallMs: 1,
    channelCount: 1,
    metrics: createChannelCatalogReadMetrics(),
  });
  assert.equal(disabled.written.length, 0);

  const failing = sink({
    RELAY_AUTHORITY_OBSERVABILITY_AE: {
      writeDataPoint: () => { throw new Error("Analytics Engine unavailable"); },
    },
  });
  assert.doesNotThrow(() => recordChannelCatalogObservation(failing.env, {
    outcome: "client_error",
    totalWallMs: 2,
    channelCount: 0,
    metrics: createChannelCatalogReadMetrics(),
  }));
});

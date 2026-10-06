import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHANNEL_CATALOG_OPERATION_TIMEOUT_MS,
  CHANNEL_CATALOG_TOTAL_TIMEOUT_MS,
  channelCatalogTimeoutResponse,
  createChannelCatalogDeadline,
  isChannelCatalogTimeoutError,
} from "../src/channel-catalog-deadline.ts";

test("catalog timeout constants keep Hub inside the browser attempt boundary", () => {
  assert.equal(CHANNEL_CATALOG_TOTAL_TIMEOUT_MS, 12_000);
  assert.equal(CHANNEL_CATALOG_OPERATION_TIMEOUT_MS, 4_000);
  assert.ok(CHANNEL_CATALOG_OPERATION_TIMEOUT_MS < CHANNEL_CATALOG_TOTAL_TIMEOUT_MS);
  assert.ok(CHANNEL_CATALOG_TOTAL_TIMEOUT_MS < 15_000);
});

test("one stalled operation fails at its boundary and produces retry guidance", async () => {
  const observed = [];
  const deadline = createChannelCatalogDeadline({
    totalTimeoutMs: 100,
    operationTimeoutMs: 10,
    onTimeout: (boundary) => observed.push(boundary),
  });
  let error;
  try {
    await deadline.wait("authority_page", new Promise(() => {}));
  } catch (caught) {
    error = caught;
  }
  assert.equal(isChannelCatalogTimeoutError(error), true);
  assert.equal(error.boundary, "authority_page");
  assert.deepEqual(observed, ["authority_page"]);

  const response = channelCatalogTimeoutResponse(error);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.deepEqual(await response.json(), {
    error: "Channel catalog is temporarily unavailable",
    code: "channel_catalog_timeout",
    retryable: true,
    boundary: "authority_page",
  });
});

test("the absolute budget bounds a sequence of otherwise-fast operations", async () => {
  let nowMs = 0;
  const deadline = createChannelCatalogDeadline({
    totalTimeoutMs: 12,
    operationTimeoutMs: 10,
    now: () => nowMs,
  });
  assert.equal(await deadline.wait("directory", Promise.resolve("ok")), "ok");
  nowMs = 12;
  await assert.rejects(
    deadline.wait("projection", Promise.resolve("too late")),
    (error) => isChannelCatalogTimeoutError(error) && error.boundary === "projection",
  );
});

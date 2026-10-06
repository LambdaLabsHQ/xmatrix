import assert from "node:assert/strict";
import test from "node:test";

import {
  browserTraceMode,
  browserWorkerCount,
} from "../apps/web/e2e/runtime-policy.mjs";

test("browser workers leave host headroom and stay bounded", () => {
  assert.equal(browserWorkerCount(1), 1);
  assert.equal(browserWorkerCount(4), 3);
  assert.equal(browserWorkerCount(8), 6);
  assert.equal(browserWorkerCount(12), 8);
  assert.equal(browserWorkerCount(64), 8);
});

test("browser worker policy rejects invalid host parallelism", () => {
  for (const value of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => browserWorkerCount(value), /positive integer/);
  }
});

test("CI records traces on retry while ad-hoc failures retain their trace", () => {
  assert.equal(browserTraceMode(true), "on-first-retry");
  assert.equal(browserTraceMode(false), "retain-on-failure");
});

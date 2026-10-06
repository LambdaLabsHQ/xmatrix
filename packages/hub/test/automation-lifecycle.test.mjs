import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTOMATION_RUN_TIMEOUT_DEFAULT_MS,
  resolveAutomationRunTimeoutMs,
} from "../src/automation-lifecycle.ts";

test("scheduled execution timeout is bounded and defaults to thirty minutes", () => {
  assert.equal(resolveAutomationRunTimeoutMs(undefined), AUTOMATION_RUN_TIMEOUT_DEFAULT_MS);
  assert.equal(resolveAutomationRunTimeoutMs("1800000"), 30 * 60_000);
  assert.equal(resolveAutomationRunTimeoutMs("1500"), 1_500);
  assert.equal(resolveAutomationRunTimeoutMs("999"), AUTOMATION_RUN_TIMEOUT_DEFAULT_MS);
  assert.equal(resolveAutomationRunTimeoutMs(String(24 * 60 * 60_000 + 1)),
    AUTOMATION_RUN_TIMEOUT_DEFAULT_MS);
});

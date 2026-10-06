import assert from "node:assert/strict";
import { test } from "node:test";

import { interfaceMemberNames } from "./support/typescript-interfaces.mjs";
import { readHubSource as read } from "./support/hub-source.mjs";

/**
 * Locks schedule-occurrence CLOSED:
 * - storage port + lifecycle interface dependency inversion
 * - SQL-only Lifecycle members (no abandon / run cleanup)
 * - no class facades / barrel re-exports for lifecycle free-function names
 * - orchestration depends on narrow lifecycle, migration, cleanup, and delivery ports
 */

const domainPath = "src/relay-authority-schedule-occurrence.ts";
const domain = read(domainPath);

const LIFECYCLE_MEMBERS = new Set([
  "maintain",
  "claim",
  "cancel",
  "fail",
  "getAutomation",
  "markPrepared",
  "markDispatched",
  "finishMessage",
  "assertPrepared",
  "requireEvaluationAuthority",
]);

test("ScheduleOccurrenceLifecycle AST members are exact SQL lifecycle set without abandon", () => {
  const names = interfaceMemberNames(domainPath, domain, "ScheduleOccurrenceLifecycle");
  assert.deepEqual(names, [...LIFECYCLE_MEMBERS].sort());
  assert.ok(!names.includes("abandonRun"));
  assert.ok(!names.includes("abandon"));
});

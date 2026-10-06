import assert from "node:assert/strict";
import { test } from "node:test";

import { interfaceMemberNames } from "./support/typescript-interfaces.mjs";
import { readHubSource as read } from "./support/hub-source.mjs";

/**
 * Locks scheduled run-cleanup boundary:
 * - independent module/interface/collaborator (not ScheduleOccurrenceLifecycle)
 * - once constructed on RelayAuthority
 * - old mega-host abandon track deleted
 * - dispatch injects runCleanup separately from schedule lifecycle
 */

const cleanupPath = "src/relay-authority-scheduled-run-cleanup.ts";
const cleanup = read(cleanupPath);

const CLEANUP_MEMBERS = new Set(["abandon"]);

test("ScheduledRunCleanup AST members are exactly abandon", () => {
  const names = interfaceMemberNames(cleanupPath, cleanup, "ScheduledRunCleanup");
  assert.deepEqual(names, [...CLEANUP_MEMBERS].sort());
});

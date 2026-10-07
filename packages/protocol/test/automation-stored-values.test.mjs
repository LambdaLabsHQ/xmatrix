import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATION_MAX_INTERVAL_MINUTES, AUTOMATION_MIN_INTERVAL_MINUTES, automationRunIdentity, canonicalAutomationCommand, isAutomationIntervalMinutes, legacyAutomationCommandKind, legacyAutomationCommandView } from "../dist/index.js";

test("an Automation cadence is one pair of bounds", () => {
  assert.equal(AUTOMATION_MIN_INTERVAL_MINUTES, 15);
  assert.equal(AUTOMATION_MAX_INTERVAL_MINUTES, 30 * 24 * 60);
  assert.equal(isAutomationIntervalMinutes(15), true);
  assert.equal(isAutomationIntervalMinutes(30 * 24 * 60), true);
  assert.equal(isAutomationIntervalMinutes(14), false);
  assert.equal(isAutomationIntervalMinutes(30 * 24 * 60 + 1), false);
  assert.equal(isAutomationIntervalMinutes(15.5), false);
});

test("Automation commands in the pre-rename spelling canonicalize, and the legacy view inverts it", () => {
  const legacy = { commandId: "c", kind: "scheduled_task_put", taskId: "a", expectedVersion: 2 };
  const current = { commandId: "c", kind: "automation_put", automationId: "a", expectedVersion: 2 };
  assert.deepEqual(canonicalAutomationCommand(legacy), current);
  assert.deepEqual(canonicalAutomationCommand(current), current);
  assert.deepEqual(legacyAutomationCommandView(current), legacy);
  assert.deepEqual(canonicalAutomationCommand({ kind: "scheduled_task_remove", taskId: "a" }),
    { kind: "automation_remove", automationId: "a" });
  assert.deepEqual(legacyAutomationCommandView({ kind: "scheduled_execution_cancel", automationId: "a" }),
    { kind: "scheduled_execution_cancel", taskId: "a" });
  const other = { kind: "run_create", taskId: "untouched" };
  assert.equal(canonicalAutomationCommand(other), other);
  assert.equal(legacyAutomationCommandView(other), other);
  assert.equal(legacyAutomationCommandKind("automation_remove"), "scheduled_task_remove");
  assert.equal(legacyAutomationCommandKind("scheduled_execution_cancel"), "scheduled_execution_cancel");
});

test("Run metadata identifies its Automation only under the automation spelling", () => {
  assert.deepEqual(automationRunIdentity({ automationId: "a", automationName: "n",
    automationOccurrenceId: "o" }), { automationId: "a", automationName: "n", automationOccurrenceId: "o" });
  assert.deepEqual(automationRunIdentity({ scheduledTaskId: "a", scheduledTaskName: "n",
    scheduledOccurrenceId: "o" }), {}, "0081 rewrote every pre-rename key");
  assert.deepEqual(automationRunIdentity({ automationId: " ", automationOccurrenceId: "" }), {});
  assert.deepEqual(automationRunIdentity(undefined), {});
});

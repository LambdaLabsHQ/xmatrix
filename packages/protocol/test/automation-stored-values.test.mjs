import assert from "node:assert/strict";
import test from "node:test";
import { automationRunIdentity } from "../dist/index.js";

test("Run metadata identifies its Automation only under the automation spelling", () => {
  assert.deepEqual(automationRunIdentity({ automationId: "a", automationName: "n",
    automationOccurrenceId: "o" }), { automationId: "a", automationName: "n", automationOccurrenceId: "o" });
  assert.deepEqual(automationRunIdentity({ scheduledTaskId: "a", scheduledTaskName: "n",
    scheduledOccurrenceId: "o" }), {}, "0081 rewrote every pre-rename key");
  assert.deepEqual(automationRunIdentity({ automationId: " ", automationOccurrenceId: "" }), {});
  assert.deepEqual(automationRunIdentity(undefined), {});
});

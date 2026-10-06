import assert from "node:assert/strict";
import test from "node:test";
import { machineExecutionCompleted, scheduledMachineExecutionCompleted } from "../dist/machine-execution-outcome.js";

test("execution completion does not depend on a reply or a legacy delivered flag", () => {
  for (const delivered of [undefined, false, true]) {
    for (const statusPhase of ["turn_completed", "run_delivery_failed"]) {
      const payload = { statusPhase, completed: true, exitCode: 0, delivered };
      assert.equal(machineExecutionCompleted(payload), true);
      assert.equal(scheduledMachineExecutionCompleted(payload), true);
    }
    assert.equal(machineExecutionCompleted({ delivered }), false);
    assert.equal(scheduledMachineExecutionCompleted({ delivered }), false);
  }
});

test("a failed phase or nonzero exit beats legacy completion and delivery claims", () => {
  for (const statusPhase of ["turn_failed", "wrapper_startup_failed", "turn_interrupted", "runtime_starting", "private-unknown"]) {
    const payload = { statusPhase, status: "completed", completed: true, delivered: true };
    assert.equal(machineExecutionCompleted(payload), false);
    assert.equal(scheduledMachineExecutionCompleted(payload), false);
  }
  for (const exitCode of [1, -1, "0", NaN]) {
    assert.equal(machineExecutionCompleted({ statusPhase: "turn_completed", completed: true, exitCode }), false);
  }
});

test("legacy completion stays bounded and scheduled Runs still require phase evidence", () => {
  assert.equal(machineExecutionCompleted({ completed: true, delivered: false }), true);
  assert.equal(machineExecutionCompleted({ status: "completed" }), true);
  assert.equal(machineExecutionCompleted({ statusPhase: "completed", completed: true }), true);
  assert.equal(scheduledMachineExecutionCompleted({ statusPhase: "completed", completed: true }), false);
  assert.equal(scheduledMachineExecutionCompleted({ status: "completed", completed: true, delivered: true }), false);
  assert.equal(machineExecutionCompleted({ statusPhase: "turn_completed", completed: false }), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { finalizeMachineRunTerminalReportsWith } from "../src/machine-run-terminal-finalizer.ts";

function report(runId, eventType = "machine_run_exited") {
  return { runId, eventType, ownerUserId: "owner", ownerEmail: "owner@example.test", machineId: "machine",
    hostId: "host", channelId: "channel", connectionEpoch: 7, requestId: `request-${runId}`,
    payload: { runId, executionKey: `execution-${runId}` }, attempts: 1, leaseOwner: "worker" };
}

function fixture(claimed, port = {}) {
  const events = [], settlements = [];
  const repository = {
    pruneFinalized: async () => { events.push("prune"); return 0; },
    claim: async () => claimed,
    settle: async (input) => { settlements.push({ runId: input.report.runId, finalized: input.finalized,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}) }); },
  };
  const effects = {
    commitLifecycle: async (value) => { events.push(`lifecycle:${value.runId}`); return {}; },
    terminateInstance: async (instanceId) => { events.push(`terminate:${instanceId}`); },
    ...port,
  };
  return { events, settlements, run: () => finalizeMachineRunTerminalReportsWith(repository, effects, "channel-1") };
}

test("a report is finalized only after its lifecycle commits and its ended Instances close", async () => {
  const f = fixture([report("run-1", "machine_stop_result")], {
    commitLifecycle: async (value) => {
      f.events.push(`lifecycle:${value.runId}`);
      return { terminalInstanceIds: ["instance-1"] };
    },
  });
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.events, ["prune", "lifecycle:run-1", "terminate:instance-1"]);
  assert.deepEqual(f.settlements, [{ runId: "run-1", finalized: true }]);
});

test("one failing report retries alone and never blocks the others", async () => {
  const f = fixture([report("run-1"), report("run-2")], {
    commitLifecycle: async (value) => {
      if (value.runId === "run-1") throw new Error("Lifecycle unavailable");
      f.events.push(`lifecycle:${value.runId}`);
      return {};
    },
  });
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.settlements.sort((a, b) => a.runId.localeCompare(b.runId)), [
    { runId: "run-1", finalized: false, errorCode: "Lifecycle unavailable" },
    { runId: "run-2", finalized: true },
  ]);
});

test("only a valid committed Instance list closes sockets", async () => {
  const f = fixture([report("run-1")], {
    commitLifecycle: async () => ({ terminalInstanceIds: ["valid", null] }),
  });
  assert.equal(await f.run(), 0);
  assert.ok(!f.events.some((event) => event.startsWith("terminate:")), "validate the whole list before any close");
  assert.match(f.settlements[0].errorCode, /Invalid authoritative terminal Instance list/);
});

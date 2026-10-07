import assert from "node:assert/strict";
import test from "node:test";

import { resumableChannelRun, runEndRestState } from "../dist/instance-rest-state.js";
import { PostgresMachineLifecycleRepository } from "../dist/runtime-lifecycle-control.js";
import { dedicatedPlacementRow } from "./recording-database.fixture.mjs";

const resumable = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
  resumeSessionKey: "resume:owner:channel-1:instance-1" };

test("only a conversation Run with a harness session can rest", () => {
  assert.equal(resumableChannelRun(resumable), true);
  for (const metadata of [
    { ...resumable, resumeSessionKey: undefined },
    { ...resumable, routedAs: "management_channel_about" },
    { ...resumable, channelDeliveryEnabled: false },
    { ...resumable, automationId: "automation-1" },
    { ...resumable, instanceDeletion: { state: "pending" } },
    { ...resumable, instanceHandoff: { successorInstanceId: "instance-2" } },
  ]) assert.equal(resumableChannelRun(metadata), false, JSON.stringify(metadata));
});

test("a Run's end decides its Instance's rest", () => {
  const end = (overrides) => runEndRestState({ metadata: resumable, previousRunStatus: "running",
    nextRunStatus: "exited", ...overrides });
  assert.equal(end({ restReason: "sleeping" }), "sleeping");
  assert.equal(end({}), "interrupted", "an exit nobody asked for is an interruption");
  assert.equal(end({ previousRunStatus: "stopping", restReason: "sleeping" }), "stopped",
    "a requested stop wins over a concurrent sleep");
  assert.equal(end({ nextRunStatus: "stopped" }), "stopped");
  assert.equal(end({ metadata: { ...resumable, stopRequest: { sourceMessageId: "kill" } } }), "stopped");
  assert.equal(end({ previousRunStatus: "starting" }), null, "a Run that never connected failed at startup");
  assert.equal(end({ nextRunStatus: "completed" }), null);
});

function lifecycleDatabase(run) {
  const calls = [];
  return { calls, cacheMode: "disabled", async transaction(_context, callback) {
    return callback({ async query(query) {
      calls.push(query);
      if (query.name === "channel_space_directory_resolve_v2") return [{ channel_id: "channel-1",
        space_id: "space-1", shard_id: "shard-1", placement_epoch: 7, entity_version: 4 }];
      if (query.name === "space_placement_resolve_v1") return [dedicatedPlacementRow()];
      if (query.name === "machine_lifecycle_channel_v2") return [{ channel_id: "channel-1", space_id: "space-1" }];
      if (query.name === "machine_lifecycle_run_lock_v2") return [{ run_id: "run-1", owner_user_id: "user-1",
        channel_id: "channel-1", version: 3, metadata_json: resumable, instance_id: "instance-1",
        instance_status: "online", instance_version: 2, channel_instance_id: 4, agent_name: "Codex", ...run }];
      if (query.name === "machine_lifecycle_instance_rest_v1") return [{ instance_id: "instance-1" }];
      if (query.name === "machine_lifecycle_head_advance_v1") return [{ commit_sequence: 15 }];
      return [];
    } });
  } };
}

async function applyReport(run, eventType, payload, extra = {}) {
  const db = lifecycleDatabase(run);
  await new PostgresMachineLifecycleRepository(db).apply({ commandId: `${eventType}-1`, ownerUserId: "user-1",
    machineId: "machine-1", hostId: "host-1", channelId: "channel-1", eventType,
    principal: { kind: "machine", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1" },
    payload: { runId: "run-1", executionKey: "execution-1", ...payload }, ...extra });
  return db.calls.find((query) => query.name === "machine_lifecycle_instance_rest_v1");
}

test("the daemon's sleep report leaves the Instance sleeping", async () => {
  const rest = await applyReport({ status: "running" }, "machine_run_exited", { restReason: "sleeping" });
  assert.deepEqual(rest.values.slice(0, 1), ["sleeping"]);
  assert.equal(rest.values[4], false);
  // Nothing overwrites a stop.
  assert.match(rest.text, /rest_state<>'stopped'/u);
});

test("an exit without a sleep report interrupts the Instance", async () => {
  const rest = await applyReport({ status: "running" }, "machine_run_exited", {});
  assert.equal(rest.values[0], "interrupted");
});

test("a sleep report after a snapshot retired the same Run refines interrupted to sleeping", async () => {
  const rest = await applyReport({ status: "exited", instance_status: "offline" }, "machine_run_exited",
    { restReason: "sleeping" });
  assert.equal(rest.values[0], "sleeping");
  assert.equal(rest.values[4], true, "only an interrupted or unset rest may be refined");
});

test("a confirmed stop leaves the Instance stopped unless it is a reborn predecessor", async () => {
  const stopped = await applyReport({ status: "running" }, "machine_stop_result", { ok: true });
  assert.equal(stopped.values[0], "stopped");
  assert.equal(await applyReport({ status: "running" }, "machine_stop_result", { ok: true },
    { preserveInstanceForReborn: true }), undefined);
});

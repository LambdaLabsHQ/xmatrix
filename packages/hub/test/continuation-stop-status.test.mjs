import assert from "node:assert/strict";
import test from "node:test";

import { machineCommandStatus, machineRepository } from "../src/machines.ts";
import { continuationStopStatusQuery } from "../src/reborn-reconcile.ts";

/** Continuations read the exact predecessor stop they stored. New handoffs
 * retain their source Instance, while legacy intents omitted the flag. Both
 * remain readable without weakening exact command matching. */

const env = { RELAY_POSTGRES: { connectionString: "postgres://unused" },
  RELAY_POSTGRES_SHARD_ID: "shard" };

// What runtime-reborn.ts recordIntent stores for each kind.
function stopPayload(kind, preserve = true) {
  return { type: "machine_stop_agent", requestId: `${kind}:0-stop:s`, runId: "run-old", channelId: "channel",
    executionKey: "exec", agentId: "instance", instanceId: "instance",
    ...(preserve ? { preserveInstanceForReborn: true } : {}),
    worktreeDisposition: "retain", reason: kind === "reborn" ? "Durable reborn requested" : "Handoff requested" };
}

function intentRow(kind, payload = stopPayload(kind)) {
  return { stop_control_id: `${kind}:0-stop:s`, source_run_id: "run-old", source_instance_id: "instance",
    owner_user_id: "owner", machine_id: "machine", hostname: "host", stop_payload_json: payload };
}

function storedStop(stored, resultJson = { ok: true }) {
  return machineRepository(env, { cacheMode: "disabled", transaction: async (_context, callback) => callback({
    query: async (query) => query.name === "machine_control_status_v3" ? [{ command_type: "stop",
      payload_json: stored, status: "completed", result_json: resultJson, completed_at: null,
      machine_id: "machine", hostname: "host" }] : [] }) });
}

const readStatus = (row, stored) =>
  machineCommandStatus(storedStop(stored), "rebornStop", continuationStopStatusQuery(row));

test("a handoff and a reborn each read their own predecessor stop", async () => {
  for (const kind of ["handoff", "reborn"]) {
    assert.equal((await readStatus(intentRow(kind), stopPayload(kind))).status, "completed", kind);
  }
  const legacy = stopPayload("handoff", false);
  assert.equal((await readStatus(intentRow("handoff", legacy), legacy)).status, "completed");
});

test("a stop with different retention semantics is still refused", async () => {
  // The intent remembers a reborn, but the stored stop retires the Instance.
  await assert.rejects(readStatus(intentRow("reborn"), stopPayload("handoff", false)), { status: 403 });
  // The intent remembers a handoff, but the stored stop would keep the Instance.
  await assert.rejects(readStatus(intentRow("handoff", stopPayload("handoff", false)), stopPayload("reborn")), { status: 403 });
});

test("a caller that predates handoffs still means a reborn stop", async () => {
  const { preserveInstanceForReborn: _omitted, ...legacy } = continuationStopStatusQuery(intentRow("reborn"));
  await assert.rejects(machineCommandStatus(storedStop(stopPayload("handoff", false), null), "rebornStop", legacy),
    { status: 403 });
});

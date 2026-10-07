import assert from "node:assert/strict";
import test from "node:test";
import { prepareReborn, advanceReborn } from "../dist/runtime-reborn.js";

function fixture() {
  const runId = `run:reborn:${"a".repeat(64)}`;
  const metadata = { executionKey: "successor", machineId: "machine", hostId: "host",
    resumeSessionKey: "session", resumeInstanceId: "instance" };
  const run = { runId, channelId: "channel", spaceId: "space", status: "starting", metadata,
    registration: { key: { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" } },
    workspace: { machineId: "machine", canonicalCwd: "/original" } };
  const instance = { instanceId: "instance", runId, channelId: "channel", spaceId: "space", channelInstanceId: 2, status: "offline" };
  const spawn = { type: "machine_spawn_agent", requestId: `reborn:1-spawn:${"a".repeat(64)}`,
    runId, instanceId: "instance", channelId: "channel", spaceId: "space", executionKey: "successor",
    identityId: "instance", resume: true, resumeInstanceId: "instance", resumeSessionKey: "session",
    workspace: { ownerUserId: "owner", machineId: "machine", hostId: "host", canonicalCwd: "/original" } };
  const previous = { run_id: "source", channel_id: "channel", channel_instance_id: "2",
    owner_user_id: "owner", run_status: "exited", instance_status: "offline", workspace_machine_id: "machine",
    workspace_canonical_cwd: "/original", metadata_json: { ...metadata, executionKey: "original" } };
  const intent = { state: "waiting", unexpired: true, actor_user_id: "owner", channel_id: "channel",
    source_run_id: "source", source_instance_id: "instance", owner_user_id: "owner", machine_id: "machine", hostname: "host",
    run_input_json: run, instance_input_json: instance, spawn_payload_json: spawn,
    stop_payload_json: { executionKey: "original" }, source_cancellation_json: null, stop_required: false };
  const writes = [];
  const tx = { async query(query) {
    if (query.name === "reborn_source_lock_v2") return [previous];
    if (query.name === "reborn_intent_lock_v1") return [intent];
    if (query.name.endsWith("insert_v1") || query.name.endsWith("prepared_v1")) writes.push(query);
    return [];
  } };
  return { tx, previous, writes, input: { run, instance, spawnPayload: spawn,
    sourceInstanceId: "instance", sourceRunId: "source", channelId: "channel" },
    advance: { intentId: runId, channelId: "channel" } };
}

test("Reborn preparation keeps the exact original workspace", async () => {
  const good = fixture();
  await prepareReborn(good.tx, good.input, "owner", "space", "2026-09-22T00:00:00Z");
  assert.equal(good.writes.length, 1);
  for (const field of ["canonicalCwd", "machineId"]) {
    const f = fixture();
    f.input.spawnPayload.workspace[field] = "different";
    await assert.rejects(prepareReborn(f.tx, f.input, "owner", "space", "2026-09-22T00:00:00Z"),
      error => error.code === "reborn_source_changed");
    assert.equal(f.writes.length, 0);
  }
});

test("an automatic wake rechecks rest under the source lock after a handoff stop", async () => {
  for (const rest of ["sleeping", "interrupted", "stopped", "wake_failed", null]) {
    const f = fixture();
    f.input.kind = "wake";
    f.previous.rest_state = rest;
    if (["sleeping", "interrupted"].includes(rest)) {
      await prepareReborn(f.tx, f.input, "owner", "space", "2026-10-07T00:00:00Z");
      assert.equal(f.writes.length, 1);
    } else {
      await assert.rejects(prepareReborn(f.tx, f.input, "owner", "space", "2026-10-07T00:00:00Z"),
        error => error.code === "instance_not_resting");
      assert.equal(f.writes.length, 0, "a stale wake candidate must not prepare a successor");
    }
  }
});

test("Reborn advancement fences workspace, session and ordinal changes before creating a successor", async () => {
  for (const mutate of [
    p => { p.workspace_canonical_cwd = "/different"; },
    p => { p.workspace_machine_id = "different"; },
    p => { p.metadata_json.resumeSessionKey = "different"; },
    p => { p.channel_instance_id = "3"; },
  ]) {
    const f = fixture();
    mutate(f.previous);
    await assert.rejects(advanceReborn(f.tx, f.advance, "owner", "space", "2026-09-22T00:00:00Z",
      async () => { assert.fail("must not create a changed successor"); }), error => error.code === "reborn_source_changed");
    assert.equal(f.writes.length, 0);
  }
  const good = fixture();
  let creations = 0;
  await advanceReborn(good.tx, good.advance, "owner", "space", "2026-09-22T00:00:00Z", async () => { creations++; });
  assert.equal(creations, 1);
});

test("managed Reborn preserves the durable materialization key without inventing a Workspace", async () => {
  const f = fixture();
  f.previous.workspace_machine_id = null;
  f.previous.workspace_canonical_cwd = null;
  f.previous.metadata_json.managedWorkspaceKey = "original-tree";
  delete f.input.run.workspace;
  f.input.run.metadata.managedWorkspaceKey = "original-tree";
  f.input.spawnPayload.workspace.managedKey = "original-tree";
  await prepareReborn(f.tx, f.input, "owner", "space", "2026-09-22T00:00:00Z");
  f.input.spawnPayload.workspace.managedKey = "another-tree";
  await assert.rejects(prepareReborn(f.tx, f.input, "owner", "space", "2026-09-22T00:00:00Z"),
    error => error.code === "reborn_source_changed");
});


test("Reborn does not require a hostname and retains exact execution and directory fences", async () => {
  for (const hostname of [undefined, "renamed"]) {
    const f = fixture();
    delete f.previous.metadata_json.hostId;
    delete f.input.run.metadata.hostId;
    delete f.input.spawnPayload.workspace.hostId;
    if (hostname !== undefined) f.previous.metadata_json.hostname = hostname;
    await prepareReborn(f.tx, f.input, "owner", "space", "2026-09-22T00:00:00Z");
    assert.equal(f.writes.length, 1);
    f.input.run.metadata.machineId = "other-machine";
    await assert.rejects(prepareReborn(f.tx, f.input, "owner", "space", "2026-09-22T00:00:00Z"),
      error => error.code === "reborn_source_changed");
  }
});

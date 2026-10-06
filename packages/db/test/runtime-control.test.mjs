import assert from "node:assert/strict";
import test from "node:test";

import { createAuthorityDatabaseRouter } from "../dist/router.js";
import { PostgresRuntimeRepository, RuntimeControlError } from "../dist/runtime-control.js";
import { PostgresMachineLifecycleRepository } from "../dist/runtime-lifecycle-control.js";
import { REGISTRATION_PREPARATION_REJECTION_CODES } from "@xmatrix/protocol";
import { registeredRunRows } from "./registered-run.fixture.mjs";
import { activePlacementRow, routedEntityDirectory, placedChannel, recordingDatabase as database } from "./recording-database.fixture.mjs";

const channel = {
  channel_id: "channel-1", space_id: "space-1", mode: "open",
  metadata_json: {}, version: 4,
};

test("execution token reads require current registration admission while historical Run reads remain available", async () => {
  const db = database(query => query.name === "runtime_get_run_v1" ? [{
    run_id: "run-1", owner_user_id: "owner", channel_id: "channel-1",
    status: "running", version: 1, metadata_json: {}, created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
  }] : []);
  const repository = new PostgresRuntimeRepository(db);
  const input = { requestId: "token", runId: "run-1", actorUserId: "owner" };
  assert.equal((await repository.getRun(input)).run.runId, "run-1");
  await assert.rejects(() => repository.getRun({ ...input, requireExecutionAccess: true }),
    error => error.code === "registration_run_admission_missing");
  assert.equal((await repository.getRun(input)).run.runId, "run-1");
});

/** user-1's Instance `instance-1` at version 7, `status` in `runId`; its transition commits at sequence 10. */
function instanceTransitionDatabase({ status, runId, runStatus, at }) {
  return database(query => {
    if (query.name === "runtime_entity_space_legacy_v1") return [{ space_id: "space-1" }];
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow()];
    if (query.name === "runtime_instance_transition_lock_v1") return [{ owner_user_id: "user-1", version: 7,
      status, run_id: runId, run_status: runStatus, run_version: 9, run_metadata_json: {} }];
    if (query.name === "runtime_control_head_advance_v1") return [{ commit_sequence: 10 }];
    if (query.name === "runtime_instance_route_source_v1") return [{ entity_version: 8,
      route_version: 10, updated_at: at }];
    if (query.name === "entity_space_route_placement_fence_v1") return [{ shard_id: "shard-0", placement_epoch: 1 }];
    return [];
  });
}

test("confirmed terminal transitions fence the exact Run without invoking deletion", async () => {
  const input = { commandId: "confirmed-stop", actorUserId: "user-1", at: "2026-09-20T12:00:00.000Z",
    kind: "instance_transition", instanceId: "instance-1", expectedVersion: 7,
    expectedRunId: "predecessor", status: "offline", terminal: true };
  const make = (runId = "predecessor") =>
    instanceTransitionDatabase({ status: "online", runId, runStatus: "stopped", at: input.at });
  const exact = make();
  await new PostgresRuntimeRepository(exact).mutate(input);
  assert.ok(exact.calls.some(query => query.name === "runtime_instance_transition_v2"));
  assert.equal(exact.calls.some(query => query.name?.includes("delete_")), false);
  const rebound = make("successor");
  await assert.rejects(() => new PostgresRuntimeRepository(rebound).mutate(input),
    error => error.code === "conflict" && /expected Run/u.test(error.message));
  assert.equal(rebound.calls.some(query => query.name === "runtime_instance_transition_v2"), false);
  await assert.rejects(() => new PostgresRuntimeRepository(make()).mutate({ ...input, expectedRunId: 7 }),
    error => error.code === "invalid_runtime_request");
  await assert.rejects(() => new PostgresRuntimeRepository(make()).mutate({ ...input, terminal: undefined }),
    error => error.code === "invalid_runtime_request");
});

test("an Instance's live status is written with its presentation, and never revives or retires it", async () => {
  const db = database(query => {
    if (query.name === "space_placement_resolve_v1") return [activePlacementRow()];
    if (query.name === "runtime_instance_presentation_v4") return [{ instance_id: "instance-1" }];
    return [];
  });
  const repository = new PostgresRuntimeRepository(db);
  const input = { actorUserId: "owner", requestId: "presentation", spaceId: "space-1", instanceId: "instance-1",
    presentation: { model: "m" }, at: "2026-10-03T15:34:00.000Z" };
  await repository.recordInstancePresentation({ ...input, status: "busy" });
  await repository.recordInstancePresentation(input);
  const writes = db.calls.filter(query => query.name === "runtime_instance_presentation_v4");
  assert.deepEqual(writes.map(query => query.values[3]), ["busy", null]);
  // Liveness belongs to the lifecycle: only a live row moves between live statuses.
  assert.match(writes[0].text, /status=CASE WHEN \$4::text IS NOT NULL AND status IN \('online','busy','idle'\) THEN \$4::text ELSE status END/);
  assert.equal(JSON.parse(writes[0].values[1]).status, undefined, "status stays out of the header snapshot");
  await assert.rejects(() => repository.recordInstancePresentation({ ...input, status: "offline" }),
    error => error.code === "invalid_runtime_request");
});

test("delete fencing tolerates a live Instance's turn moving it between online, busy and idle", async () => {
  const input = { commandId: "delete-prepare", actorUserId: "user-1", at: "2026-10-03T15:34:00.000Z",
    kind: "instance_transition", instanceId: "instance-1", expectedVersion: 7, status: "online",
    deletePhase: "prepare", expectedRunId: "run-1", deleteControlId: "control-1" };
  const make = (status) => instanceTransitionDatabase({ status, runId: "run-1", runStatus: "running", at: input.at });
  const busy = make("busy");
  await new PostgresRuntimeRepository(busy).mutate(input);
  assert.ok(busy.calls.some(query => query.name === "runtime_instance_delete_prepare_v1"));
  await assert.rejects(() => new PostgresRuntimeRepository(make("offline")).mutate(input),
    error => error.code === "conflict" && /delete fencing/u.test(error.message));
});

test("terminal Run transitions expire exact-instance Trace grants", async () => {
  const db = database((query) => query.name === "entity_space_route_resolve_v1"
    ? [{ entity_kind: "run", entity_id: "run-1", space_id: "space-1",
        shard_id: "shard-0", placement_epoch: 1, entity_version: 1, route_version: 10 }]
    : query.name === "space_placement_resolve_v1"
      ? [activePlacementRow()]
      : query.name === "entity_space_route_placement_fence_v1"
        ? [{ shard_id: "shard-0", placement_epoch: 1 }]
        : query.name === "runtime_run_route_source_v1"
          ? [{ entity_version: 2, route_version: 11, updated_at: "2026-08-30T00:00:02.000Z" }]
    : query.name === "runtime_run_transition_lock_v1"
      ? [{ owner_user_id: "user-1", status: "running", version: 1, instance_id: "instance-1" }]
      : query.name === "runtime_control_head_advance_v1" ? [{ commit_sequence: 11 }] : []);
  const value = await new PostgresRuntimeRepository(db).mutate({
    commandId: "command-terminal", actorUserId: "user-1", at: "2026-08-30T00:00:02.000Z",
    kind: "run_transition", runId: "run-1", expectedVersion: 1,
    status: "completed", metadata: {},
  });
  assert.equal(value.entityVersion, 2);
  const expiry = db.calls.find((call) => call.name === "runtime_trace_expire_instance_v1");
  assert.ok(expiry);
  assert.deepEqual(expiry.values, ["instance-1", "2026-08-30T00:00:02.000Z"]);
});

test("runtime authority rejects cached databases", () => {
  assert.throws(() => new PostgresRuntimeRepository({ cacheMode: "cached" }),
    (error) => error instanceof RuntimeControlError && error.code === "cached_authority_forbidden");
});

test("instance_connect retries a stale version after a timed-out predecessor claim", async () => {
  const db = database((query) => registeredRunRows(query) ?? (query.name === "entity_space_route_resolve_v1"
    ? [{ entity_kind: "instance", entity_id: "instance-1", space_id: "space-1",
        shard_id: "shard-0", placement_epoch: 1, entity_version: 2, route_version: 8 }]
    : query.name === "space_placement_resolve_v1"
      ? [activePlacementRow()]
      : query.name === "runtime_instance_connect_lock_v2"
        ? [{ instance_status: "online", instance_version: 2, run_id: "run-1",
            owner_user_id: "user-1", run_status: "running", run_version: 2,
            metadata_json: {}, launch_id: "launch-1", launch_state: "connected" }]
        : query.name === "runtime_control_head_advance_v1" ? [{ commit_sequence: 9 }]
          : query.name === "runtime_run_route_source_v1" ||
              query.name === "runtime_instance_route_source_v1"
            ? [{ entity_version: 3, route_version: 9, updated_at: "2026-09-13T00:59:00.000Z" }]
            : query.name === "entity_space_route_placement_fence_v1"
              ? [{ shard_id: "shard-0", placement_epoch: 1 }] : []));
  const value = await new PostgresRuntimeRepository(db).mutate({
    commandId: "connect-retry", actorUserId: "user-1", at: "2026-09-13T00:59:00.000Z",
    kind: "instance_connect", instanceId: "instance-1", expectedVersion: 1,
  });
  assert.equal(value.entityVersion, 3);
  assert.equal(value.launchState, "connected");
  assert.equal(db.calls.some((call) => call.name === "runtime_instance_connect_online_v2"), true);
});

test("instance_connect atomically promotes Instance, Run, and Launch", async () => {
  const db = database((query) => registeredRunRows(query) ?? (query.name === "entity_space_route_resolve_v1"
    ? [{ entity_kind: "instance", entity_id: "instance-1", space_id: "space-1",
        shard_id: "shard-0", placement_epoch: 1, entity_version: 1, route_version: 8 }]
    : query.name === "space_placement_resolve_v1"
      ? [activePlacementRow()]
      : query.name === "runtime_instance_connect_lock_v2"
        ? [{ instance_status: "offline", instance_version: 1, run_id: "run-1",
            owner_user_id: "user-1", run_status: "starting", run_version: 1,
            metadata_json: {}, launch_id: "launch-1", launch_state: "spawned" }]
        : query.name === "runtime_control_head_advance_v1" ? [{ commit_sequence: 9 }]
          : query.name === "runtime_run_route_source_v1" ||
              query.name === "runtime_instance_route_source_v1"
            ? [{ entity_version: 2, route_version: 9, updated_at: "2026-09-04T00:00:00.000Z" }]
            : query.name === "entity_space_route_placement_fence_v1"
              ? [{ shard_id: "shard-0", placement_epoch: 1 }] : []));
  const value = await new PostgresRuntimeRepository(db).mutate({
    commandId: "connect-1", actorUserId: "user-1", at: "2026-09-04T00:00:00.000Z",
    kind: "instance_connect", instanceId: "instance-1",
  });
  assert.equal(value.launchState, "connected");
  for (const name of ["runtime_instance_connect_online_v2", "runtime_instance_connect_run_v1",
    "runtime_instance_connect_launch_v1"]) {
    assert.equal(db.calls.some((call) => call.name === name), true, name);
  }
});

test("the first Agent reply is recorded once against its exact Launch", async () => {
  const db = database((query) => placedChannel(query) ?? (
    query.name === "channel_capability_runtime_terminalize_v3" ? [channel]
        : query.name === "runtime_agent_launch_first_reply_v1" ? [{ launch_age_ms: "1250" }] : []));
  const value = await new PostgresRuntimeRepository(db).recordAgentLaunchFirstReply({
    requestId: "first-reply-1", channelId: "channel-1", runId: "run-1",
    actorUserId: "user-1", at: "2026-09-04T00:00:01.250Z",
  });
  assert.deepEqual(value, { recorded: true, launchAgeMs: 1250 });
  assert.deepEqual(db.calls.find((call) => call.name === "runtime_agent_launch_first_reply_v1").values,
    ["channel-1", "run-1", "2026-09-04T00:00:01.250Z"]);
});

test("Agent Launch history remains readable after its Channel is archived", async () => {
  const archivedChannel = { ...channel, archived_at: "2026-09-13T09:47:24.026Z" };
  const launch = {
    launch_id: "launch-archived", channel_id: "channel-1", trigger_id: "message-1", target_name: "Alpha", target_runtime: "codex",
    target_metadata_json: {}, launch_kind: "agent_mention_spawn", run_id: "run-1",
    instance_id: "instance-1", state: "connected", attempt: 0, retryable: false,
    created_at: "2026-09-13T08:35:24.705Z", updated_at: "2026-09-13T08:35:25.705Z",
  };
  const db = database((query) => placedChannel(query) ?? (
    query.name === "channel_capability_runtime_history_read_v3" ? [archivedChannel]
        : query.name === "runtime_agent_launches_query_v5" ? [launch] : []));

  const value = await new PostgresRuntimeRepository(db).queryAgentLaunches({
    requestId: "archived-launch-history", channelId: "channel-1",
    sourceMessageIds: ["message-1"], actorUserId: "user-1",
  });

  assert.equal(value.launches[0].launchId, "launch-archived");
  const authorization = db.calls.find((call) =>
    call.name === "channel_capability_runtime_history_read_v3");
  assert.ok(authorization);
  assert.doesNotMatch(authorization.text, /archived_at IS NULL/u);
});

test("late daemon spawn evidence stamps a connected Launch without regressing state", async () => {
  const connected = {
    launch_id: "launch-1", channel_id: "channel-1", trigger_id: "message-1", target_name: "Alpha", target_runtime: "node",
    target_metadata_json: {}, launch_kind: "agent_mention_spawn", run_id: "run-1",
    instance_id: "instance-1", state: "connected", attempt: 0, retryable: false,
    created_at: "2026-09-04T00:00:00.000Z", updated_at: "2026-09-04T00:00:01.000Z",
    connected_at: "2026-09-04T00:00:01.000Z", spawned_at: null,
  };
  const spawnedAt = "2026-09-04T00:00:00.750Z";
  const db = database((query) => placedChannel(query) ?? (
    query.name === "channel_capability_runtime_terminalize_v3" ? [channel]
        : query.name === "runtime_agent_launch_update_lock_v3" ? [connected]
          : query.name === "runtime_agent_launch_late_evidence_v1"
            ? [{ ...connected, spawned_at: spawnedAt }] : []));

  const value = await new PostgresRuntimeRepository(db).updateAgentLaunch({
    requestId: "spawn-late", launchId: "launch-1", channelId: "channel-1",
    actorUserId: "user-1", state: "spawned", at: spawnedAt,
  });

  assert.equal(value.launch.state, "connected");
  assert.equal(value.launch.spawnedAt, spawnedAt);
  assert.deepEqual(db.calls.find((call) => call.name === "runtime_agent_launch_late_evidence_v1").values,
    ["launch-1", "spawned", spawnedAt]);
});

test("Runtime reads route Run IDs into the placed physical shard", async () => {
  const directory = routedEntityDirectory({ entity_kind: "run", entity_id: "run-routed", space_id: "space-1",
        shard_id: "shard-1", placement_epoch: 7, entity_version: 2, route_version: 11 });
  const shard0 = database(() => []);
  const shard1 = database((query) => query.name === "runtime_get_run_v1" ? [{
    run_id: "run-routed", owner_user_id: "user-1",
    channel_id: "channel-1", status: "running", version: 2, metadata_json: {},
    created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:01.000Z",
  }] : []);
  const router = createAuthorityDatabaseRouter({ directory, shards: { "shard-0": shard0,
    "shard-1": shard1 } });

  const value = await new PostgresRuntimeRepository(router).getRun({
    requestId: "runtime-read-routed", runId: "run-routed", actorUserId: "user-1",
  });

  assert.equal(value.run.runId, "run-routed");
  assert.equal(shard1.calls.some((call) => call.name === "runtime_get_run_v1"), true);
  assert.equal(shard0.calls.some((call) => call.name === "runtime_get_run_v1"), false);
});

/**
 * Machine lifecycle reads for channel-1 on its dedicated shard: `run` is the
 * Run row of user-1's `run-1` that the lifecycle locks, if any, and `rows`
 * answers further statements by name.
 */
function lifecycleDatabase(run, rows = {}) {
  return database((query) => placedChannel(query, { dedicated: true })
    ?? (query.name === "machine_lifecycle_channel_v2" ? [{ channel_id: "channel-1", space_id: "space-1" }]
      : query.name === "machine_lifecycle_run_lock_v2" && run
        ? [{ run_id: "run-1", owner_user_id: "user-1", channel_id: "channel-1", ...run }]
        : rows[query.name] ?? []));
}

/** A `eventType` report machine-1 on host-1 makes about user-1's channel-1. */
function machineReport(commandId, eventType, payload, extra = {}) {
  return { commandId, ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1", channelId: "channel-1",
    eventType, principal: { kind: "machine", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1" },
    payload, ...extra };
}

const spawnedPayload = { type: "machine_spawn_result", requestId: "spawn-1", runId: "run-1",
  channelId: "channel-1", executionKey: "execution-1", ok: true };

test("a pre-spawn failure still owes a notice when launch update already failed its Run", async () => {
  const run = { status: "failed", version: 3, metadata_json: {
    machineId: "machine-1", hostId: "host-1", executionKey: "execution-1" } };
  const context = { run_id: "run-1", channel_id: "channel-1", owner_user_id: "user-1",
    agent_name: "Codex", status: "failed", startup_failed: true, metadata_json: run.metadata_json };
  const db = lifecycleDatabase(run, { machine_lifecycle_notice_context_v5: [context],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }] });
  const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport("spawn-failed", "machine_spawn_result",
    { ...spawnedPayload, ok: false, error: "base_ref_unresolved" }));
  assert.deepEqual(value.changedRunIds, [], "an already failed Run requires no new status transition");
  assert.equal(value.startupFailureNoticeContext?.runId, "run-1");
  const replay = db.calls.find(q => q.name === "machine_lifecycle_replay_write_v1");
  assert.ok(JSON.stringify(replay.values).includes("startupFailureNoticeContext"), "notice delivery survives report replay");
});

for (const [status, recoverableLaunchFailure, routedAs, executionCancellation] of [["stopped", false], ["completed", false],
  ["starting", true], ["failed", false, "management_channel_about"], ["failed", false, undefined, { reason: "timeout" }]]) {
  test(`late spawn failure does not announce ${executionCancellation ? "cancelled" : routedAs ?? status} as a new startup failure`, async () => {
    const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1", routedAs, executionCancellation };
    const db = lifecycleDatabase({ status, version: 3, metadata_json: body }, {
      machine_lifecycle_notice_context_v5: [{ run_id: "run-1", channel_id: "channel-1", owner_user_id: "user-1",
        agent_name: "Codex", status, routed_as: routedAs, metadata_json: body }],
      machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }],
    });
    const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport("spawn-failed", "machine_spawn_result",
      { ...spawnedPayload, ok: false, error: "base_ref_unresolved" }, { recoverableLaunchFailure }));
    assert.equal(value.startupFailureNoticeContext, undefined);
  });
}

for (const cancelled of [false, true]) {
  test(`cleanup preserves ${cancelled ? "cancellation despite a late failed spawn" : "the failed-startup outcome"}`, async () => {
    const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
      ...(cancelled ? { executionCancellation: { reason: "timeout", processCleanup: { status: "pending" } } } : {}) };
    const db = lifecycleDatabase({ status: "failed", version: 3, metadata_json: body }, {
      machine_lifecycle_notice_context_v5: [{ run_id: "run-1", channel_id: "channel-1", owner_user_id: "user-1",
        agent_name: "Codex", status: "failed", startup_failed: true, metadata_json: body }],
      machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }],
    });
    const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport("cleanup", "machine_stop_result",
      { runId: "run-1", executionKey: "execution-1", requestId: "stop-1", ok: true }));
    assert.equal(value.stopResultNoticeContext.startupFailed, cancelled ? undefined : true);
    const update = db.calls.find(q => q.name === "machine_lifecycle_run_update_v1");
    assert.equal(update.values[0], "failed");
    if (cancelled) assert.equal(JSON.parse(update.values[1]).executionCancellation.processCleanup.status, "confirmed");
  });
}

test("a confirmed channel stop leaves the receipt on the command instead of a Channel notice", async () => {
  const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
    stopRequest: { sourceMessageId: "message-1", requestedAt: "2026-10-06T08:46:35.000Z" } };
  const db = lifecycleDatabase({ status: "stopping", version: 4, metadata_json: body, finished_at: null, instance_id: null }, {
    machine_lifecycle_notice_context_v5: [{ run_id: "run-1", channel_id: "channel-1", owner_user_id: "user-1",
      agent_name: "Codex", status: "stopping", metadata_json: body }],
    machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 16 }],
  });
  const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport("channel-stop", "machine_stop_result",
    { runId: "run-1", executionKey: "execution-1", requestId: "stop-1", ok: true }));
  assert.equal(value.stopResultNoticeContext, undefined);
  assert.equal(db.calls.find(query => query.name === "machine_lifecycle_run_update_v1").values[0], "stopped");
});

test("a confirmed stop with no channel command still posts its notice", async () => {
  const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1" };
  const db = lifecycleDatabase({ status: "running", version: 4, metadata_json: body, finished_at: null, instance_id: null }, {
    machine_lifecycle_notice_context_v5: [{ run_id: "run-1", channel_id: "channel-1", owner_user_id: "user-1",
      agent_name: "Codex", status: "running", metadata_json: body }],
    machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 16 }],
  });
  const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport("orphan-stop", "machine_stop_result",
    { runId: "run-1", executionKey: "execution-1", requestId: "stop-2", ok: true }));
  assert.equal(value.stopResultNoticeContext.ok, true);
  assert.equal(value.stopResultNoticeContext.startupFailed, undefined);
});

test("a failed channel stop still posts because acceptance is not termination", async () => {
  const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
    stopRequest: { sourceMessageId: "message-1" } };
  const db = lifecycleDatabase({ status: "stopping", version: 4, metadata_json: body, finished_at: null, instance_id: null }, {
    machine_lifecycle_notice_context_v5: [{ run_id: "run-1", channel_id: "channel-1", owner_user_id: "user-1",
      agent_name: "Codex", status: "stopping", metadata_json: body }],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 16 }],
  });
  const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport("channel-stop-failed", "machine_stop_result",
    { runId: "run-1", executionKey: "execution-1", requestId: "stop-3", ok: false, error: "process still running" }));
  assert.equal(value.stopResultNoticeContext.ok, false);
  assert.match(value.stopResultNoticeContext.detail, /process still running/);
});

test("authenticated Machine lifecycle advances the PostgreSQL Run and control ledger", async () => {
  const db = lifecycleDatabase({ status: "starting", version: 1, metadata_json: {
    machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
  }, finished_at: null, instance_id: null }, {
    entity_space_route_placement_fence_v1: [{ shard_id: "shard-1", placement_epoch: 7 }],
    machine_lifecycle_route_source_v1: [{ run_id: "run-1", run_version: 2, instance_id: null, instance_version: null,
      route_version: 11, updated_at: "2026-08-30T00:00:03.000Z" }],
    machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 11 }],
  });
  const value = await new PostgresMachineLifecycleRepository(db).apply(
    machineReport("command-3", "machine_spawn_result", spawnedPayload));

  assert.deepEqual(value.changedRunIds, ["run-1"]);
  assert.doesNotMatch(db.calls.find((call) => call.name === "machine_lifecycle_channel_v2").text,
    /archived_at/u, "archiving must not strand authenticated terminal Machine evidence");
  for (const name of ["machine_lifecycle_run_update_v1", "machine_lifecycle_outbox_v1",
    "machine_lifecycle_replay_write_v1", "entity_space_route_publish_v1"]) {
    assert.equal(db.calls.some((call) => call.name === name), true, name);
  }
  assert.deepEqual(db.calls.find((call) =>
    call.context?.operation === "runtime.machine-lifecycle.machine_spawn_result").context.placement,
  { spaceId: "space-1", shardId: "shard-1", placementEpoch: 7 });
});

test("a late spawn success leaves a Run a stop fenced mid-spawn stopping", async () => {
  const lifecycle = async (status) => {
    const db = lifecycleDatabase({ status, version: 2,
      metadata_json: { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
        stopRequest: { sourceMessageId: "message-1" } }, finished_at: null, instance_id: null }, {
      entity_space_route_placement_fence_v1: [{ shard_id: "shard-1", placement_epoch: 7 }],
      machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
      machine_lifecycle_head_advance_v1: [{ commit_sequence: 11 }],
    });
    await new PostgresMachineLifecycleRepository(db).apply(
      machineReport(`command-${status}`, "machine_spawn_result", spawnedPayload));
    return db.calls.find((call) => call.name === "machine_lifecycle_run_update_v1")?.values[0];
  };
  assert.equal(await lifecycle("starting"), "running");
  // The Run still records the applied spawn result, with no status change.
  assert.equal(await lifecycle("stopping"), null,
    "the spawn result must not hand a fenced Run back its authority");
});

test("persistent wrapper startup failure retires PostgreSQL Instance presence", async () => {
  const db = lifecycleDatabase({ status: "running", version: 2, metadata_json: {
    machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
  }, finished_at: null, instance_id: "instance-1", instance_status: "online", instance_version: 7 }, {
    entity_space_route_placement_fence_v1: [{ shard_id: "shard-1", placement_epoch: 7 }],
    machine_lifecycle_route_source_v1: [{ run_id: "run-1", run_version: 3, instance_id: "instance-1",
      instance_version: 8, route_version: 12, updated_at: "2026-09-06T00:00:00.000Z" }],
    machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
    machine_lifecycle_instance_offline_v1: [{ instance_id: "instance-1" }],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 12 }],
  });
  const value = await new PostgresMachineLifecycleRepository(db).apply(
    machineReport("wrapper-startup-failed", "machine_run_exited", { type: "machine_run_exited", runId: "run-1",
      executionKey: "execution-1", status: "exit code: 1", statusPhase: "wrapper_startup_failed", completed: true,
      delivered: false }));

  assert.deepEqual(value.changedRunIds, ["run-1"]);
  assert.equal(db.calls.find((call) => call.name === "machine_lifecycle_run_update_v1").values[0],
    "exited");
  const offline = db.calls.find((call) => call.name === "machine_lifecycle_instance_offline_v1");
  assert.ok(offline, "host terminal evidence must repair stale persistent Instance presence");
  assert.deepEqual(offline.values.slice(1), ["instance-1", "run-1", 7]);
});

for (const eventType of ["machine_spawn_result", "machine_run_exited", "machine_stop_result"]) {
  test(`cancelled execution cannot be revived by late ${eventType}`, async () => {
    const cancelledAt = "2026-09-13T08:00:00.000Z";
    const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1",
      automationId: "task-1", automationOccurrenceId: "occurrence-1",
      executionCancellation: { reason: "timeout", requestedAt: cancelledAt,
        processCleanup: { status: "pending", attempts: 1 } } };
    const db = lifecycleDatabase({ status: "failed", version: 3, metadata_json: body, finished_at: cancelledAt },
      { machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }] });
    const repo = new PostgresMachineLifecycleRepository(db);
    const input = machineReport(`late-${eventType}`, eventType, { runId: "run-1", executionKey: "execution-1",
      ok: true, completed: true, delivered: true, statusPhase: "turn_completed" });
    await repo.apply(input);
    const update = db.calls.find(q => q.name === "machine_lifecycle_run_update_v1");
    if (eventType === "machine_spawn_result") assert.equal(update, undefined);
    else {
      assert.ok(update);
      assert.ok([null, "failed"].includes(update.values[0]));
      const next = JSON.parse(update.values[1]);
      assert.equal(next.executionCancellation.reason, "timeout");
      assert.equal(next.executionCancellation.requestedAt, cancelledAt);
      assert.equal(next.executionCancellation.processCleanup.status, "confirmed");
    }
    for (const name of ["machine_lifecycle_launch_update_v2", "machine_lifecycle_occurrence_finish_v2",
      "machine_lifecycle_task_finish_v2"]) assert.equal(db.calls.some(q => q.name === name), false);
    if (eventType !== "machine_spawn_result") await assert.rejects(repo.apply({ ...input,
      payload: { ...input.payload, executionKey: "wrong-execution" } }), /execution key/);
  });
}

test("a registered Run's exit report records its message execution under its Instance", async () => {
  const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1" };
  // A registered Run has no Profile: its name comes from the registration.
  const db = lifecycleDatabase({ status: "running", version: 3, metadata_json: body,
    instance_id: "instance-1", instance_status: "online", instance_version: 2, channel_instance_id: 4,
    agent_name: "Codex" }, { machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }] });
  // One clock read: a later finishedAt than updatedAt is an invalid report.
  const now = Date.now();
  const taskExecution = { execution: { executionId: "execution:1", revision: 1, sourceCount: 1,
    sources: [{ channelId: "channel-1", messageId: "message-1", sequence: 1, entityVersion: 1, bodyHash: "a".repeat(64) }],
    state: "completed", startedAtMillis: now - 1000, updatedAtMillis: now, finishedAtMillis: now } };
  await new PostgresMachineLifecycleRepository(db).apply(machineReport("exit-1", "machine_run_exited",
    { runId: "run-1", executionKey: "execution-1", taskExecution }));
  const upsert = db.calls.find(q => q.name === "runtime_message_execution_upsert_v2");
  assert.ok(upsert, "the execution is recorded");
  assert.deepEqual(upsert.values.slice(4, 6), ["instance-1", "Codex"]);
});

for (const ok of [true, false]) test(`an applied ${ok ? "successful" : "recoverable failed"} spawn result marks its Run with the exact spawn command`, async () => {
  const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1", spawnControlId: "control-1" };
  const db = lifecycleDatabase({ status: "starting", version: 3, metadata_json: body,
    instance_id: "instance-1", instance_status: "offline", instance_version: 1, channel_instance_id: 1 }, {
    machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
    machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }],
  });
  await new PostgresMachineLifecycleRepository(db).apply(machineReport(`spawn-${ok}`, "machine_spawn_result",
    { requestId: "control-1", runId: "run-1", executionKey: "execution-1", instanceId: "instance-1", ok,
      ...(ok ? { pid: 1 } : { error: "spawn failed" }) }, { recoverableLaunchFailure: !ok }));
  // Owner delete waits for this marker: the spawn command completes before it.
  const update = db.calls.find(q => q.name === "machine_lifecycle_run_update_v1");
  assert.ok(update, "the Run records the applied spawn result even when its status is unchanged");
  assert.deepEqual({ ...JSON.parse(update.values[1]).spawnResult, at: undefined },
    { controlId: "control-1", ok, at: undefined });
});

test("a Channel About session's spawn is its start: its launch connects, so its Run ending is no failure", async () => {
  const body = { machineId: "machine-1", hostId: "host-1", executionKey: "execution-1", spawnControlId: "control-1",
    routedAs: "management_channel_about" };
  for (const [instance, expected] of [[{}, "connected"], [{ instance_id: "instance-1", instance_status: "offline",
    instance_version: 1, channel_instance_id: 1 }, "spawned"]]) {
    const db = lifecycleDatabase({ status: "starting", version: 3, metadata_json: body, ...instance }, {
      machine_lifecycle_run_update_v1: [{ run_id: "run-1" }],
      machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }],
    });
    await new PostgresMachineLifecycleRepository(db).apply(machineReport(`spawn-${expected}`, "machine_spawn_result",
      { requestId: "control-1", runId: "run-1", executionKey: "execution-1", ok: true, pid: 1 }));
    const launch = db.calls.find(q => q.name === "machine_lifecycle_launch_update_v2");
    assert.equal(launch.values[1], expected, instance.instance_id ? "an Instance's launch connects when it does" : "no Instance to wait for");
  }
});

for (const rejectionCode of ['routing_no_eligible', 'routing_selection_failed', 'routing_parameter_selection_failed',
  'routing_parameter_constraints_invalid', 'routing_parameter_models_empty', 'routing_parameter_workspaces_empty',
  'routing_parameter_catalog_invalid', 'routing_parameter_catalog_unavailable', 'routing_parameter_invalid_answer',
  'routing_parameter_jev_aborted', 'routing_parameter_jev_invalid_input', 'routing_parameter_jev_customer_verification_required',
  'routing_parameter_jev_auth_failed', 'routing_parameter_jev_permission_denied', 'routing_parameter_jev_rate_limited',
  'routing_parameter_jev_evaluation_failed', 'routing_evidence_unavailable', ...REGISTRATION_PREPARATION_REJECTION_CODES,
  // A typed domain code without a public explanation is still recorded by name.
  'allocation_environment_mismatch'])
test(`routing rejection ${rejectionCode} binds publication, replays once, and never creates a Run`, async () => {
  const { digestCanonicalCloneCborV1 } = await import('@xmatrix/protocol');
  const body = '@auto machine:missing inspect';
  const bodyHash = await digestCanonicalCloneCborV1(body);
  let saved;
  let allowed = true;
  let published = true;
  const db = database(query => {
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'channel-1', space_id: 'space-1', shard_id: 'shard-0', placement_epoch: 1, entity_version: 4 }];
    if (query.name === 'space_placement_resolve_v1') return [activePlacementRow()];
    if (['channel_capability_runtime_new_work_v3', 'channel_capability_runtime_history_read_v3'].includes(query.name)) return allowed ? [channel] : [];
    if (query.name === 'runtime_initial_message_source_v4') return published ? [{ entity_version: 1, body_hash: bodyHash, timeline_sequence: 1 }] : [];
    if (query.name === 'runtime_invocation_rejections_v4') return saved ? [{ ...saved, command_id: 'routing-preflight:message', created_at: '2026-09-22T18:00:00Z', expires_at: '2026-09-23T18:00:00Z' }] : [];
    if (query.name === 'runtime_replay_read_v1') return saved ? [saved] : [];
    if (query.name === 'runtime_replay_write_v1') saved = { command_kind: query.values[2], request_digest: query.values[3], result_json: JSON.parse(query.values[4]) };
    return [];
  });
  const repository = new PostgresRuntimeRepository(db);
  const input = { channelId: 'channel-1', sourceMessageId: 'message', actorUserId: 'user-1',
    rejected: [{ sourceMention: '@auto machine:missing', code: rejectionCode,
      ...(rejectionCode === 'routing_parameter_invalid_answer' ? { answerFailure: {
        questionKey: 'workspace', issue: 'choice_not_offered', private: 'must-not-store' } } : {}),
      routingDecision: {
      source: 'deterministic', evaluatedAt: '2026-09-22T18:00:00Z', candidateCount: 1, secret: 'must-not-store',
      rows: [{ harness: 'codex', machineId: 'machine-a', activeRuns: 1,
        maxConcurrent: 1, selected: false, excluded: ['machine_mismatch'],
        quotaObservation: { status: 'stale', observedAt: '2026-09-22T17:00:00Z', expiresAt: '2026-09-22T17:10:00Z', source: 'provider', token: 'must-not-store' } }] } }] };
  const value = await repository.recordRoutingRejections(input);
  const view = await repository.queryAgentLaunches({ requestId: 'view', actorUserId: 'user-1', channelId: 'channel-1', sourceMessageIds: ['message'] });
  assert.equal(view.rejections[0].code, rejectionCode);
  if (rejectionCode === 'routing_parameter_invalid_answer') assert.match(view.rejections[0].message,
    /"workspace" answer selected an option that was not offered/);
  assert.doesNotMatch(JSON.stringify(view.rejections), /must-not-store/);
  assert.equal(value.rejected[0].routingDecision.rows[0].quotaObservation.status, 'stale');
  assert.doesNotMatch(JSON.stringify(saved), /must-not-store/);
  assert.equal((await repository.recordRoutingRejections(input)).reused, true);
  assert.equal(db.calls.filter(call => call.name === 'runtime_replay_write_v1').length, 1);
  assert.equal(db.calls.some(call => call.name?.includes('run_create')), false);
  published = false;
  await assert.rejects(() => repository.recordRoutingRejections(input), /Source message changed/);
  published = true; allowed = false;
  await assert.rejects(() => repository.recordRoutingRejections(input));
  assert.equal(db.calls.filter(call => call.name === 'runtime_replay_write_v1').length, 1);
});

test('an untyped rejection value is refused rather than stored', async () => {
  const repository = new PostgresRuntimeRepository(database(() => []));
  await assert.rejects(() => repository.recordRoutingRejections({ channelId: 'channel-1', sourceMessageId: 'message',
    actorUserId: 'user-1', rejected: [{ sourceMention: '@auto x', code: 'Provider said: token abc' }] }), /Invalid rejection code/);
});

for (const snapshotComplete of [false, true]) {
  test(`a ${snapshotComplete ? "full" : "partial"} snapshot ${snapshotComplete ? "retires" : "never retires"} an unreported Run`, async () => {
    const old = "2026-09-01T00:00:00.000Z";
    const db = lifecycleDatabase(undefined, {
      machine_lifecycle_snapshot_head_v2: [{ registry_sequence: 9 }],
      machine_lifecycle_snapshot_runs_v4: ["run-1", "run-2"].map((runId, index) => ({
        run_id: runId, status: "running", version: 3, updated_at: old, instance_id: `instance-${index + 1}`,
        instance_version: 2, instance_status: "online", channel_instance_id: `channel-1:${index + 1}`,
        metadata_json: { machineId: "machine-1", hostId: "host-1", executionKey: `execution-${index + 1}` } })),
      machine_lifecycle_head_advance_v1: [{ commit_sequence: 15 }],
    });
    // Each retired Run's exit reports that Run.
    const exit = db.transaction;
    db.transaction = (context, callback) => exit(context, (tx) => callback({ async query(query) {
      const rows = await tx.query(query);
      return query.name === "machine_lifecycle_snapshot_run_exit_v1" ? [{ run_id: query.values[1] }] : rows;
    } }));
    const value = await new PostgresMachineLifecycleRepository(db).apply(machineReport(
      `snapshot-${snapshotComplete}`, "machine_run_snapshot", { type: "machine_run_snapshot", snapshotComplete,
        registryConnectionEpoch: 4, registrySequence: 9, capturedAt: new Date().toISOString(),
        runs: [{ runId: "run-1", executionKey: "execution-1", statusPhase: "turn_running" }] },
      { connectionEpoch: 4 }));
    const exits = db.calls.filter(q => q.name === "machine_lifecycle_snapshot_run_exit_v1");
    assert.deepEqual(exits.map(q => q.values[1]), snapshotComplete ? ["run-2"] : []);
    assert.deepEqual(value.changedRunIds, snapshotComplete ? ["run-2"] : []);
    assert.equal(db.calls.some(q => q.name === "machine_lifecycle_snapshot_head_v2"), snapshotComplete);
    const progress = db.calls.filter(q => q.name === "machine_lifecycle_invocation_progress_v1");
    assert.deepEqual(progress.map(q => q.values[2]), ["run-1"]);
  });
}

test("Instance quota persistence uses its Run binding and leaves no per-Instance quota copy", async () => {
  const db = database(query => {
    if (query.name === "space_placement_resolve_v1") return [{ space_id: "space-1", shard_id: "shard-0",
      placement_epoch: 1, state: "active", target_shard_id: null, plan_class: "shared" }];
    if (query.name === "runtime_instance_presentation_v4") return [{ instance_id: "instance-1", run_id: "bound-run" }];
    if (query.name === "runtime_instance_quota_binding_v1") {
      assert.deepEqual(query.values, ["bound-run", "space-1"]);
      return [{ owner_user_id: "owner", machine_id: "bound-machine", harness: "claude" }];
    }
    return [];
  });
  const result = await new PostgresRuntimeRepository(db).recordInstancePresentation({ requestId: "observe",
    actorUserId: "owner", spaceId: "space-1", instanceId: "instance-1", at: new Date().toISOString(),
    presentation: { model: "m", usage: { totalTokens: 7, contextUsedTokens: 3, quotaSource: "provider_api", quotaUsages: [{ percent: 100 }] } } });
  assert.deepEqual(result.registration, { ownerUserId: "owner", machineId: "bound-machine", harness: "claude" });
  const write = db.calls.find(query => query.name === "runtime_instance_presentation_v4");
  assert.deepEqual(JSON.parse(write.values[1]), { model: "m", usage: { totalTokens: 7, contextUsedTokens: 3 } });
  assert.equal(write.values[4], "owner");
});

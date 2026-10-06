import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresAutomationRepository,
  AutomationControlError,
  automationName,
} from "../dist/automation-control.js";
import { createAuthorityDatabaseRouter } from "../dist/router.js";
import { dedicatedPlacementRow, routedEntityDirectory, recordingDatabase as database } from "./recording-database.fixture.mjs";

function placed(respond) {
  return (query) => query.name === "channel_space_directory_resolve_v2"
    ? [{ channel_id: "channel-1", space_id: "space-1", shard_id: "shard-1",
        placement_epoch: 7, entity_version: 4 }]
    : query.name === "space_placement_resolve_v1"
      ? [dedicatedPlacementRow()]
      : query.name === "automation_route_source_v1"
        ? [{ route_version: 12, updated_at: "2026-08-30T00:00:00.000Z" }]
        : query.name === "entity_space_route_placement_fence_v1"
          ? [{ shard_id: "shard-1", placement_epoch: 7 }]
          : respond(query);
}

const channel = {
  channel_id: "channel-1", space_id: "space-1", mode: "open",
  archived_at: null, metadata_json: {}, version: 1,
};

function evaluatorPayload(actor = { kind: "user", id: "user-1" }, authorityRootUserId = "user-1",
  rootMessageId = "message-root") {
  return { payloadVersion: 3, intervalMinutes: 15, input: {
    datum: { kind: "text", language: "natural-language", ref: "input-1", text: "Review" },
    envRef: { root: { kind: "channel", id: "channel-1" }, actor, authorityRootUserId },
    resume: { kind: "interval", intervalMinutes: 15 },
    lineage: { rootMessageId, depth: 0, budget: 8 },
  } };
}

test("Automation authority creates a Human-owned task in PostgreSQL", async () => {
  const db = database(placed((query) => query.name === "channel_capability_automation_new_work_v3"
    ? [channel]
    : query.name === "automation_creation_policy_v1"
        ? [{ policy: "members", role: "member" }]
        : query.name === "automation_control_head_v1"
          ? [{ commit_sequence: 12 }]
          : []));
  const value = await new PostgresAutomationRepository(db).mutate({
    commandId: "command-1", actorUserId: "user-1", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-1", expectedVersion: 0,
    channelId: "channel-1", nextRunAt: "2026-08-30T01:00:00.000Z", enabled: true,
    payload: evaluatorPayload(),
  });

  assert.deepEqual({ entityId: value.entityId, entityVersion: value.entityVersion,
    reused: value.reused }, { entityId: "task-1", entityVersion: 1, reused: false });
  for (const name of ["automation_insert_v2", "automation_control_head_v1",
    "automation_outbox_v2", "automation_replay_write_v1"]) {
    assert.equal(db.calls.some((call) => call.name === name), true, name);
  }
  assert.match(db.calls.find((call) => call.name === "automation_outbox_v2").text,
    /outbox_id,space_id,topic,aggregate_kind,aggregate_id,aggregate_sequence/u);
  // C1: the stored values use the Automation spelling; the wire kind does not change.
  assert.equal(value.kind, "automation_put");
  assert.equal(db.calls.find((call) => call.name === "automation_outbox_v2").values[3], "automation");
  assert.equal(db.calls.find((call) => call.name === "automation_replay_write_v1").values[2], "automation_put");
  assert.equal(db.calls.find((call) => call.name === "entity_space_route_publish_v1").values[0], "automation");
  assert.deepEqual(db.calls.find((call) => call.context?.operation ===
    "automation.automation_put").context.placement,
  { spaceId: "space-1", shardId: "shard-1", placementEpoch: 7 });
  assert.equal(db.calls.some((call) => call.name === "entity_space_route_publish_v1"), true);
});

test("Automation authority enforces the Space creation policy", async () => {
  const db = database(placed((query) => query.name === "channel_capability_automation_new_work_v3"
    ? [channel]
    : query.name === "automation_creation_policy_v1"
        ? [{ policy: "admins", role: "member" }]
        : []));
  await assert.rejects(new PostgresAutomationRepository(db).mutate({
    commandId: "command-2", actorUserId: "user-1", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-2", expectedVersion: 0,
    channelId: "channel-1", nextRunAt: "2026-08-30T01:00:00.000Z", enabled: true,
    payload: evaluatorPayload(),
  }), (error) => error instanceof AutomationControlError &&
    error.code === "space_member_automation_creation_disabled");
});

const authoredTask = { automation_id: "task-authored", owner_user_id: "user-1", channel_id: "channel-1",
  next_run_at: "2026-08-30T01:00:00.000Z", enabled: true, version: 3,
  payload_json: evaluatorPayload(), created_at: "2026-08-29T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z" };

function memberPauseDatabase(task = authoredTask) {
  return database(placed((query) =>
    query.name === "automation_entity_space_legacy_v1" ? [{ space_id: "space-1" }]
      : query.name === "automation_current_lock_v1" ? [task]
        : query.name === "channel_capability_automation_new_work_v3" ? [channel]
          : query.name === "automation_control_head_v1" ? [{ commit_sequence: 14 }] : []));
}

test("any Channel member manages another member's evaluation without an admin role", async () => {
  const db = memberPauseDatabase();
  const paused = await new PostgresAutomationRepository(db).mutate({
    commandId: "command-member-pause", actorUserId: "user-2", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-authored", expectedVersion: 3,
    channelId: "channel-1", nextRunAt: "2026-08-30T01:00:00.000Z", enabled: false,
    payload: evaluatorPayload(), automationAction: "pause",
  });
  assert.equal(paused.entityVersion, 4);
  assert.equal(db.calls.some((call) => call.name === "automation_manager_role_v1"), false);
  const update = db.calls.find((call) => call.name === "automation_update_v1");
  assert.equal(update.values[2], false);
});

test("a stale pause conflicts and does not disable the Automation", async () => {
  const db = memberPauseDatabase();
  await assert.rejects(new PostgresAutomationRepository(db).mutate({
    commandId: "command-stale-pause", actorUserId: "user-2", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-authored", expectedVersion: 2,
    channelId: "channel-1", nextRunAt: "2026-08-30T01:00:00.000Z", enabled: false,
    payload: evaluatorPayload(), automationAction: "pause",
  }), (error) => error instanceof AutomationControlError && error.code === "conflict"
    && error.message === "Automation version changed");
  assert.equal(db.calls.some((call) => call.name === "automation_update_v1"), false);
});

function managementPauseDatabase() {
  return database(placed((query) =>
    query.name === "automation_entity_space_legacy_v1" ? [{ space_id: "space-1" }]
      : query.name === "automation_current_lock_v1" ? [authoredTask]
        : query.name.startsWith("channel_capability_") ? [channel]
          : query.name === "automation_agent_authority_v3"
            ? [{ channel_id: "channel-manager", space_id: "space-1", instance_id: "manager:1",
                metadata_json: { executionKey: "execution-1", machineId: "machine-1", hostId: "host-1",
                  managementSpaceId: "space-1", managementConfigGeneration: 2 },
                config_version: 2, config_json: { enabled: true, sideEffectsEnabled: true } }]
            : query.name === "automation_control_head_v1" ? [{ commit_sequence: 14 }] : []));
}

function managementMutation(automationAction, enabled) {
  return {
    commandId: `command-management-${automationAction}`, actorUserId: "user-2", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-authored", expectedVersion: 3,
    channelId: "channel-1", nextRunAt: "2026-08-31T00:00:00.000Z", enabled, automationAction,
    // Re-serialized by the Hub under the Agent; a pause keeps the person's own.
    payload: evaluatorPayload({ kind: "agent", id: "manager:1" }, "user-2"),
    principal: { kind: "agent", id: "manager:1" },
    automationAgent: { ownerUserId: "user-2", runId: "run-manager", executionKey: "execution-1",
      channelId: "channel-manager", machineId: "machine-1", hostId: "host-1", instanceId: "manager:1",
      managementSpaceId: "space-1" },
    managementAudit: { actionId: `audit-${automationAction}`, actionType: `automation_${automationAction}`,
      evidence: {}, reason: "The report is no longer needed", payloadHash: "hash", idempotencyKey: "key" },
  };
}

test("the management Agent pauses a person's Automation directly and leaves an audit", async () => {
  const db = managementPauseDatabase();
  const paused = await new PostgresAutomationRepository(db).mutate(managementMutation("pause", false));
  assert.equal(paused.entityVersion, 4);
  const update = db.calls.find((call) => call.name === "automation_update_v1");
  assert.equal(update.values[1], authoredTask.next_run_at, "the schedule stays the person's");
  assert.equal(update.values[2], false);
  assert.deepEqual(JSON.parse(update.values[4]), evaluatorPayload(), "the definition stays the person's");
  const audit = db.calls.find((call) => call.name === "automation_management_audit_v1");
  assert.equal(audit.values[2], "automation_pause");
  assert.equal(JSON.parse(audit.values[3]).automationGovernance.reason, "The report is no longer needed");
});

test("the management Agent may not otherwise change a person's Automation", async () => {
  for (const [action, enabled] of [["update", true], ["resume", true]]) {
    await assert.rejects(new PostgresAutomationRepository(managementPauseDatabase())
      .mutate(managementMutation(action, enabled)),
    (error) => error instanceof AutomationControlError && error.status === 403);
  }
});

test("an Agent cannot pause a page Automation outside its page", async () => {
  const db = memberPauseDatabase({ ...authoredTask, page_id: "page-1" });
  await assert.rejects(new PostgresAutomationRepository(db).mutate(managementMutation("pause", false)),
    (error) => error instanceof AutomationControlError && error.code === "forbidden"
      && error.message === "A page's Automation is changed through its page, as the Agent's owner");
  assert.equal(db.calls.some((call) => call.name === "automation_update_v1"), false);
});

function replacementDb(overrides = {}) {
  return database(placed((query) => {
    if (Object.hasOwn(overrides, query.name)) return overrides[query.name];
    return query.name === "channel_capability_automation_new_work_v3" ? [channel]
      : query.name === "automation_replaced_lock_v1" ? [authoredTask]
        : query.name === "automation_creation_policy_v1" ? [{ policy: "members", role: "member" }]
          : query.name === "automation_remove_replaced_v1" ? [{ automation_id: "task-authored" }]
            : query.name === "automation_control_head_v1" ? [{ commit_sequence: 15 }] : [];
  }));
}

function replacement(db, extra = {}) {
  return new PostgresAutomationRepository(db).mutate({
    commandId: "command-replace", actorUserId: "user-2", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-replacement", expectedVersion: 0,
    channelId: "channel-1", nextRunAt: "2026-08-30T01:00:00.000Z", enabled: true,
    payload: evaluatorPayload({ kind: "user", id: "user-2" }, "user-2", "input-replacement"),
    automationAction: "update",
    replacesAutomation: { automationId: "task-authored", expectedVersion: 3 }, ...extra,
  });
}

test("a member rewriting another member's evaluation replaces it with one authored by the member", async () => {
  const db = replacementDb();
  const value = await replacement(db);
  assert.deepEqual({ entityId: value.entityId, entityVersion: value.entityVersion },
    { entityId: "task-replacement", entityVersion: 1 });
  const inserted = db.calls.find((call) => call.name === "automation_insert_v2");
  assert.equal(inserted.values[1], "user-2");
  assert.deepEqual(db.calls.find((call) => call.name === "automation_remove_replaced_v1").values,
    ["task-authored", 3]);
  assert.equal(db.calls.find((call) => call.name === "automation_cancel_replaced_occurrences_v1").values[1],
    "task-authored");
  const published = db.calls.filter((call) => call.name === "entity_space_route_publish_v1")
    .map((call) => call.values);
  assert.equal(published.some((values) => values.includes("task-authored") && values.includes("deleted")), true);
  assert.equal(published.some((values) => values.includes("task-replacement") && values.includes("active")), true);
});

test("a replacement cannot keep the replaced author's authority", async () => {
  await assert.rejects(replacement(replacementDb(), {
    payload: evaluatorPayload(),
  }), (error) => error instanceof AutomationControlError && error.code === "invalid_automation_request");
});

test("a replacement fails closed for the author, a stale version, a lineage, a policy and an Agent", async () => {
  await assert.rejects(replacement(replacementDb(), { actorUserId: "user-1",
    payload: evaluatorPayload() }), (error) => error.code === "forbidden");
  await assert.rejects(replacement(replacementDb(), {
    replacesAutomation: { automationId: "task-authored", expectedVersion: 2 },
  }), (error) => error.code === "conflict");
  await assert.rejects(replacement(replacementDb({
    automation_replaced_lineage_v1: [{ automation_id: "task-child" }],
  })), (error) => error.code === "conflict");
  await assert.rejects(replacement(replacementDb({
    automation_creation_policy_v1: [{ policy: "admins", role: "member" }],
  })), (error) => error.code === "space_member_automation_creation_disabled");
  await assert.rejects(replacement(replacementDb(), {
    principal: { kind: "agent", id: "agent-1" },
  }), (error) => error.code === "forbidden");
  const nothingRemoved = replacementDb({ automation_replaced_lineage_v1: [{ automation_id: "task-child" }] });
  await assert.rejects(replacement(nothingRemoved));
  assert.equal(nothingRemoved.calls.some((call) => call.name === "automation_remove_replaced_v1"), false);
});

test("a live Agent creates only its exact evaluator authority in PostgreSQL", async () => {
  const db = database(placed((query) => query.name === "channel_capability_automation_new_work_v3"
    ? [channel]
    : query.name === "automation_agent_authority_v3"
      ? [{ channel_id: "channel-1", space_id: "space-1", profile_name: "Reviewer",
          metadata_json: { executionKey: "execution-1", machineId: "machine-1", hostId: "host-1" },
          instance_id: "instance-1", config_version: null, config_json: null }]
      : query.name === "automation_creation_policy_v1"
          ? [{ policy: "members", role: "member" }]
          : query.name === "automation_control_head_v1"
            ? [{ commit_sequence: 13 }]
            : []));
  const value = await new PostgresAutomationRepository(db).mutate({
    commandId: "command-agent", actorUserId: "user-1", at: "2026-08-30T00:00:00.000Z",
    kind: "automation_put", automationId: "task-agent", expectedVersion: 0,
    channelId: "channel-1", nextRunAt: "2026-08-30T01:00:00.000Z", enabled: true,
    principal: { kind: "agent", id: "agent-1" },
    automationAgent: { ownerUserId: "user-1", runId: "run-1", executionKey: "execution-1",
      channelId: "channel-1", machineId: "machine-1", hostId: "host-1", instanceId: "instance-1" },
    payload: evaluatorPayload({ kind: "agent", id: "agent-1" }),
  });
  assert.equal(value.entityId, "task-agent");
  assert.equal(db.calls.some((call) => call.name === "automation_insert_v2"), true);
});

test("a registration Run's Instance lists Automations in its birth Channel without a Profile grant", async () => {
  const db = database(placed((query) => query.name === "automation_agent_authority_v3"
    ? [{ channel_id: "channel-1", space_id: "space-1", profile_name: null,
        metadata_json: { executionKey: "execution-1", machineId: "machine-1", hostId: "host-1" },
        instance_id: "channel-1:1", config_version: null, config_json: null }]
    : query.name === "automation_agent_birth_binding_v1" ? [{ present: 1 }]
      : query.name === "automation_agent_list_v4" ? [{
        automation_id: "task-agent", owner_user_id: "user-1", channel_id: "channel-1",
        next_run_at: "2026-08-30T01:00:00.000Z", enabled: true, version: 1,
        payload_json: evaluatorPayload({ kind: "agent", id: "channel-1:1" }), run_count: 0,
        created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z" }]
        : []));
  const value = await new PostgresAutomationRepository(db).list({
    requestId: "list-instance", channelId: "channel-1",
    principal: { kind: "agent", id: "channel-1:1" },
    automationAgent: { ownerUserId: "user-1", runId: "channel-1:1#1", executionKey: "execution-1",
      channelId: "channel-1", machineId: "machine-1", hostId: "host-1", instanceId: "channel-1:1" },
  });
  assert.deepEqual(value.tasks.map((task) => task.id), ["task-agent"]);
  const access = db.calls.find((call) => call.name === "automation_agent_birth_binding_v1");
  // A registration Instance is bound to its birth Channel without a
  // data.channel_access row; a Profile still needs its revocable grant.
  assert.match(access.text, /run_agent_registrations/u);
  assert.match(access.text, /data\.channel_access/u);
  assert.equal(db.calls.some((call) => call.name === "automation_agent_read_access_v1"), false);
});

test("Automation authority rejects cached PostgreSQL", () => {
  assert.throws(() => new PostgresAutomationRepository({ cacheMode: "cached" }),
    (error) => error instanceof AutomationControlError &&
      error.code === "cached_authority_forbidden");
});

test("Automation reads include archived Channels and route opaque Automation IDs into the placed shard", async () => {
  const directory = routedEntityDirectory({ entity_kind: "automation", entity_id: "task-routed", space_id: "space-1",
        shard_id: "shard-1", placement_epoch: 7, entity_version: 1, route_version: 12 });
  const shard0 = database(() => []);
  const shard1 = database((query) => query.name === "automation_get_v5" ? [{
    automation_id: "task-routed", owner_user_id: "user-1", channel_id: "channel-1",
    next_run_at: "2026-08-30T01:00:00.000Z", enabled: true, version: 1,
    payload_json: evaluatorPayload(), can_manage: true, run_count: 0,
    archived_at: "2026-08-30T00:00:00.000Z",
    created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
  }] : []);
  const router = automationRouter(directory, shard0, shard1);

  const value = await new PostgresAutomationRepository(router).get({
    requestId: "task-read-routed", automationId: "task-routed",
    principal: { kind: "user", id: "user-1" },
  });

  assert.equal(value.task.id, "task-routed");
  assert.doesNotMatch(shard1.calls.find((call) => call.name === "automation_get_v5").text,
    /c\.archived_at IS NULL/u);
  assert.equal(shard1.calls.some((call) => call.name === "automation_get_v5"), true);
  assert.equal(shard0.calls.some((call) => call.name === "automation_get_v5"), false);
});

test("Automation projection distinguishes delivered message IDs from Agent Run IDs", async () => {
  for (const [payloadVersion, lastRunId, expected] of [
    [2, "scheduled-message:occurrence-1", "scheduled-message:occurrence-1"],
    [3, "scheduled-message:occurrence-1", "scheduled-message:occurrence-1"],
    [3, "run:agent-1", undefined],
    [3, null, undefined],
    [1, "scheduled-message:occurrence-1", undefined],
  ]) {
    const db = database(placed(query => query.name === "automation_list_v5" ? [{
      automation_id: "task-1", owner_user_id: "user-1", channel_id: "channel-1",
      next_run_at: "2026-08-30T01:00:00.000Z", enabled: true, version: 1,
      payload_json: { ...evaluatorPayload(), payloadVersion }, can_manage: true,
      run_count: lastRunId ? 1 : 0, last_run_id: lastRunId,
      created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
    }] : []));
    const result = await new PostgresAutomationRepository(db).list({
      requestId: "delivered-message-projection", principal: { kind: "user", id: "user-1" },
      spaceId: "space-1", limit: 20,
    });
    const task = result.tasks[0];
    assert.equal(task.lastMessageId, expected);
    assert.equal(Object.hasOwn(task, "lastMessageId"), expected !== undefined);
    assert.equal(task.deliveryCount, lastRunId ? 1 : 0);
    assert.equal(task.lastRunId, lastRunId ?? undefined);
  }
});

test("unscoped Automation catalogs fan only active membership routes into shards", async () => {
  const directory = database((query) => query.name === "user_space_membership_routes_list_v1"
    ? [
        { user_id: "user-1", space_id: "space-0", role: "member", shard_id: "shard-0",
          placement_epoch: 3, membership_version: 1, route_version: 8 },
        { user_id: "user-1", space_id: "space-1", role: "member", shard_id: "shard-1",
          placement_epoch: 7, membership_version: 1, route_version: 12 },
      ] : []);
  const task = (taskId, channelId) => ({
    automation_id: taskId, owner_user_id: "user-1", channel_id: channelId,
    next_run_at: "2026-08-30T01:00:00.000Z", enabled: true, version: 1,
    payload_json: evaluatorPayload(), can_manage: true, run_count: 0,
    created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
  });
  const shard0 = database((query) => query.name === "automation_list_shard_v5"
    ? [task("task-b", "channel-0")] : []);
  const shard1 = database((query) => query.name === "automation_list_shard_v5"
    ? [task("task-a", "channel-1")] : []);
  const router = automationRouter(directory, shard0, shard1);

  const value = await new PostgresAutomationRepository(router).list({
    requestId: "task-list-routed", principal: { kind: "user", id: "user-1" }, limit: 20,
  });

  assert.deepEqual(value.tasks.map((item) => item.id), ["task-a", "task-b"]);
  assert.equal(shard0.calls.some((call) => call.name === "automation_list_shard_v5"), true);
  assert.equal(shard1.calls.some((call) => call.name === "automation_list_shard_v5"), true);
});

test("an Automation list for a Space that does not exist is not found, not an outage", async () => {
  const db = database(() => []);
  await assert.rejects(new PostgresAutomationRepository(db).list({
    requestId: "task-list-unknown-space", principal: { kind: "user", id: "user-1" },
    spaceId: "space-missing", limit: 20,
  }), (error) => error instanceof AutomationControlError && error.status === 404
    && error.code === "space_not_found");
});

test("scheduled occurrence maintenance materializes one due cadence in PostgreSQL", async () => {
  const due = { automation_id: "task-1", owner_user_id: "user-1", channel_id: "channel-1",
    next_run_at: "2026-08-30T00:00:00.000Z", enabled: true, version: 1,
    payload_json: { payloadVersion: 3, intervalMinutes: 15,
      input: { datum: { kind: "text", language: "natural-language", text: "Review" } } } };
  const db = database((query) => query.name === "scheduled_occurrence_count_v2"
    ? [{ count: 0 }]
    : query.name === "automation_due_lock_v2"
      ? [due]
      : query.name === "natural_key_counter_bump_instance_v1"
        ? [{ last_value: 7 }]
        : []);
  await new PostgresAutomationRepository(db).maintain({
    requestId: "maintenance-1", now: "2026-08-30T00:00:00.000Z", runTimeoutMs: 1_800_000,
  });

  const insert = db.calls.find((call) => call.name === "scheduled_occurrence_insert_v3");
  assert.ok(insert);
  assert.equal(insert.values[1], "task-1");
  // The occurrence records the natural key it reserved in the Automation's Channel.
  assert.deepEqual([insert.values[6], insert.values[7]], ["channel-1:7#1", "channel-1:7"]);
  assert.equal(insert.values[9], "message");
  assert.equal(db.calls.some((call) => call.name === "automation_advance_v2"), true);
});

test("an occurrence takes the events that made it due; while one runs, they wait a minute, not a cadence", async () => {
  const events = [{ id: "github:acme/widgets#9:merged", kind: "merged", summary: "Pull request #9 was merged" }];
  const due = { automation_id: "task-1", owner_user_id: "user-1", channel_id: "channel-1", page_id: "page-1",
    next_run_at: "2026-08-30T00:00:00.000Z", enabled: true, version: 1, trigger_events: events,
    payload_json: { payloadVersion: 3, intervalMinutes: 720,
      input: { datum: { kind: "text", language: "natural-language", text: "Review" } } } };
  const maintain = async (active) => {
    const db = database((query) => query.name === "scheduled_occurrence_count_v2" ? [{ count: 0 }]
      : query.name === "automation_due_lock_v2" ? [due]
        : query.name === "scheduled_occurrence_active_v2" ? active
          : query.name === "natural_key_counter_bump_instance_v1" ? [{ last_value: 7 }] : []);
    await new PostgresAutomationRepository(db).maintain({
      requestId: "maintenance-events", now: "2026-08-30T00:00:00.000Z", runTimeoutMs: 1_800_000 });
    return db.calls;
  };
  const created = await maintain([]);
  const insert = created.find((call) => call.name === "scheduled_occurrence_insert_v3");
  assert.deepEqual(JSON.parse(insert.values[12]), events);
  const taken = created.find((call) => call.name === "automation_advance_v2");
  assert.equal(taken.values[5], true, "the Automation's events are taken");
  assert.equal(taken.values[0], "2026-08-30T12:00:00.000Z");

  const waiting = await maintain([{ occurrence_id: "running", status: "dispatched", automation_version: 1 }]);
  assert.equal(waiting.some((call) => call.name === "scheduled_occurrence_insert_v3"), false);
  const advanced = waiting.find((call) => call.name === "automation_advance_v2");
  assert.equal(advanced.values[0], "2026-08-30T00:01:00.000Z", "it checks back in a minute to take them");
  assert.equal(advanced.values[5], false);

  // Events run it at most hourly: after a run ten minutes ago, the follow-up waits out the hour.
  due.last_run_at = "2026-08-29T23:50:00.000Z";
  const spaced = (await maintain([{ occurrence_id: "running", status: "dispatched", automation_version: 1 }]))
    .find((call) => call.name === "automation_advance_v2");
  assert.equal(spaced.values[0], "2026-08-30T00:50:00.000Z");
});

test("scheduled occurrence claim returns the exact fenced lease", async () => {
  const db = database((query) => query.name === "scheduled_occurrence_claim_v3"
    ? [{ occurrence_id: "occurrence-1", automation_id: "task-1", automation_version: 2,
        owner_user_id: "user-1", scheduled_for: "2026-08-30T00:00:00.000Z",
        status: "leased", lease_owner: "worker-1", lease_until: "2026-08-30T00:01:00.000Z",
        attempts: 1, next_attempt_at: "2026-08-30T00:00:00.000Z", run_id: "run-1",
        instance_id: "instance-1", control_id: "control-1", delivery_kind: "message",
        message_id: "message-1", error_code: null, error_message: null,
        execution_timeout_ms: 1_800_000, execution_deadline_at: null,
        created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
        finished_at: null }]
    : []);
  const claimed = await new PostgresAutomationRepository(db).claim({
    requestId: "claim-1", now: "2026-08-30T00:00:00.000Z", leaseOwner: "worker-1",
  });
  assert.equal(claimed.id, "occurrence-1");
  // PostgreSQL automation_id/automation_version map onto the occurrence row
  // shape the Hub shares with the Durable Object authority.
  assert.equal(claimed.task_id, "task-1");
  assert.equal(claimed.task_version, 2);
  assert.equal(claimed.lease_owner, "worker-1");
  assert.equal(claimed.attempts, 1);
  const query = db.calls.find((call) => call.name === "scheduled_occurrence_claim_v3");
  assert.doesNotMatch(query.text, /archived_at/u, "a once-archived conversation's Automations still run");
  assert.match(query.text, /\(\$2::text IS NULL OR c\.space_id=\$2\)/u);
  assert.equal(query.values[1], null);
  assert.equal(query.values[2], "worker-1");
});

test("a Channel's Automation wake covers cadence, retry, lease, timeout and terminal convergence", async () => {
  const db = database((query) => query.name === "automation_next_channel_wake_v1"
    ? [{ wake_at: "2026-08-30T00:00:05.000Z" }] : []);
  const wakeAt = await new PostgresAutomationRepository(db).nextChannelAutomationWakeAt({
    requestId: "next-wake-1", channelId: "channel-1",
  });
  assert.equal(wakeAt, "2026-08-30T00:00:05.000Z");
  const query = db.calls.find((call) => call.name === "automation_next_channel_wake_v1");
  assert.deepEqual(query.values, ["channel-1"]);
  assert.equal(query.text.match(/UNION ALL/gu).length + 1,
    query.text.match(/WHERE t\.channel_id=\$1 AND /gu).length, "every wake branch is filtered to the Channel");
  assert.match(query.text, /t\.enabled=true/u);
  assert.doesNotMatch(query.text, /archived_at/u);
  assert.match(query.text, /status='pending'/u);
  assert.match(query.text, /status IN \('leased','prepared'\)/u);
  assert.match(query.text, /execution_deadline_at/u);
  assert.match(query.text, /executionCancellation,processCleanup,nextAttemptAt/u);
  assert.match(query.text, /status='dispatched' AND o\.finished_at IS NULL/u);
  assert.match(query.text, /INTERVAL '2 minutes'/u);
});

test("the cutover pages Channels that have Automation work", async () => {
  const db = database((query) => query.name === "automation_channels_with_work_v1"
    ? [{ channel_id: "channel-2" }, { channel_id: "channel-3" }] : []);
  const channels = await new PostgresAutomationRepository(db).channelsWithAutomationWork({
    requestId: "handover-1", afterChannelId: "channel-1", limit: 2 });
  assert.deepEqual(channels, ["channel-2", "channel-3"]);
  const query = db.calls.find((call) => call.name === "automation_channels_with_work_v1");
  assert.deepEqual(query.values, ["channel-1", 2]);
  assert.match(query.text, /t\.enabled=true OR EXISTS/u);
  assert.match(query.text, /o\.finished_at IS NULL/u);
});

test("scheduled effect cleanup is fenced to the selected Space", async () => {
  const db = database(placed(() => []));
  const repository = new PostgresAutomationRepository(db);
  await repository.claimTimeoutStops({ requestId: "timeout-space-1",
    now: "2026-08-30T00:00:00.000Z", spaceId: "space-1" });
  await repository.finalizeOrphanedRuns({ requestId: "orphans-space-1",
    now: "2026-08-30T00:00:00.000Z", cutoff: "2026-08-29T23:58:00.000Z",
    spaceId: "space-1" });
  for (const name of ["scheduled_cancel_cleanup_claim_v3", "scheduled_orphaned_runs_v2"]) {
    const query = db.calls.find((call) => call.name === name);
    assert.match(query.text, /\(\$2::text IS NULL OR c\.space_id=\$2\)/u, name);
    assert.equal(query.values[1], "space-1", name);
  }
});

test("an Automation stored without a name is named from what it does", () => {
  assert.equal(automationName("Code audit", "@auto audit"), "Code audit");
  assert.equal(automationName(undefined, "\n  @auto repo:o/r audit this section\nmore"), "@auto repo:o/r audit this section");
  assert.equal(automationName("  ", "x".repeat(120)), "x".repeat(80));
  assert.equal(automationName(null, ""), "Automation");
});

function automationRouter(directory, shard0, shard1) {
  return createAuthorityDatabaseRouter({ directory, shards: { "shard-0": shard0, "shard-1": shard1 } });
}

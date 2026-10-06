import assert from "node:assert/strict";
import test from "node:test";
import { registeredRunRows } from "../../db/test/registered-run.fixture.mjs";

import { refreshAgentRoutingQuota, registrationQuotaProbeTargetReader } from "../src/agent-routing-quota-refresh.ts";
import { runtimeRepository } from "../src/runtime.ts";

function runtimeDatabase(queries) {
  return {
    cacheMode: "disabled",
    async transaction(_context, callback) {
      return callback({
        async query(query) {
          queries.push(query);
          const admission = registeredRunRows(query, { runId: "run-1", spaceId: "space-1", ownerUserId: "user-1" });
          if (admission) return admission;
          if (query.name === "channel_space_directory_resolve_v2") return [{
            channel_id: "channel-1", space_id: "space-1", shard_id: "shard-1",
            placement_epoch: 1, entity_version: 1,
          }];
          if (query.name === "entity_space_route_resolve_v1") return [{
            entity_kind: "run", entity_id: "run-1", space_id: "space-1", shard_id: "shard-1",
            placement_epoch: 1, entity_version: 1, route_version: 1,
          }];
          if (query.name === "runtime_diagnostic_run_v3") return [{
            run_id: query.values[0], owner_user_id: "user-1", target_name: "Registered Codex",
            channel_id: "channel-1", instance_id: "instance-1", run_status: "running",
            run_updated_at: "2026-09-13T00:00:00Z", run_metadata_json: { executionKey: "execution-1" },
          }];
          if (query.name === "runtime_diagnostic_caller_v2") return [{
            owner_user_id: "user-1", instance_id: "instance-1",
            channel_id: "channel-1", status: "running", metadata_json: { executionKey: "execution-1" },
          }];
          if (query.name === "space_placement_resolve_v1") return [{
            space_id: "space-1", shard_id: "shard-1", placement_epoch: 1,
            state: "active", target_shard_id: null, plan_class: "single",
          }];
          if (query.name?.startsWith("channel_capability_runtime_")) return [{
            channel_id: "channel-1", space_id: "space-1", mode: "open",
            metadata_json: {}, version: 1,
          }];
          if (query.name === "runtime_kill_targets_v5") return [{
            instance_id: "instance-1", run_id: "run-1", channel_instance_id: 1,
            owner_user_id: "user-1",
            machine_owner_user_id: "user-1", agent_name: "codex",
            metadata_json: { machineId: "machine-1", hostId: "host-1",
              executionKey: "execution-1" },
          }];
          if (query.name === "runtime_reborn_target_v4") return [{
            instance_id: "instance-1", instance_status: "online", channel_instance_id: 1,
            run_id: "run-1", owner_user_id: "user-1",
            workspace_machine_id: "machine-1", workspace_canonical_cwd: "/srv/repo",
            metadata_json: {}, run_status: "running", agent_name: "codex", harness: "codex",
          }];
          return [];
        },
      });
    },
  };
}

const runtime = (queries) => runtimeRepository({}, runtimeDatabase(queries));

test("quota refresh reads authorized registrations before any machine work", async () => {
  const queries = [];
  const database = runtimeDatabase(queries);
  const result = await refreshAgentRoutingQuota({ env: {}, directory: database, runtime: runtimeRepository({}, database),
    channelId: "channel-1", actorUserId: "user-1",
    registrationTargets: registrationQuotaProbeTargetReader(database, database) });
  assert.deepEqual(result, { issued: 0 });
  const capability = queries.findIndex(query => query.name?.startsWith("channel_capability_runtime_"));
  const targets = queries.findIndex(query => query.name === "registration_quota_probe_registrations_v1");
  assert.ok(capability >= 0 && targets > capability, queries.map(query => query.name).join(","));
  assert.equal(queries.some(query => query.name?.startsWith("machine_control_issue")), false);
});

test("Channel Agent control targets are registered Runs' Instances", async () => {
  const queries = [];
  assert.deepEqual(await runtime(queries).listChannelAgentKillTargets({ requestId: "kill",
    channelId: "channel-1", actorUserId: "user-1", limit: 200 }), {
    targets: [{
      instanceId: "instance-1", runId: "run-1", agentId: "instance-1",
      agentName: "codex", mentionTarget: "codex:1", ownerUserId: "user-1",
      machineOwnerUserId: "user-1", machineId: "machine-1", hostId: "host-1",
      executionKey: "execution-1",
    }],
    cursor: null,
  });
  const reborn = await runtime(queries).getChannelAgentRebornTarget({ requestId: "reborn",
    channelId: "channel-1", agentName: "Codex", channelInstanceId: 1, actorUserId: "user-1" });
  assert.deepEqual(reborn.target, {
    instanceId: "instance-1", instanceStatus: "online", channelId: "channel-1",
    channelInstanceId: 1, runId: "run-1", runStatus: "running",
    agentName: "codex", harness: "codex", ownerUserId: "user-1",
    workspace: { machineId: "machine-1", canonicalCwd: "/srv/repo" }, metadata: {},
  });
  const killTargetsQuery = queries.find((query) => query.name === "runtime_kill_targets_v5");
  assert.match(killTargetsQuery?.text ?? "", /target\.run_status IN \('starting','running','stopping'\)/u);
  // A Run a `/kill all` append fenced stays a target until its host confirms.
  assert.match(killTargetsQuery?.text ?? "", /OR target\.metadata_json \? 'stopRequest'/u);
  // A target is a registered Run's Instance.
  assert.match(killTargetsQuery?.text ?? "", /JOIN data\.run_agent_registrations b/u);
  assert.doesNotMatch(killTargetsQuery?.text ?? "", /agent_profile/u);
  // An Instance is found only through its registration.
  const rebornTargetQuery = queries.find((query) => query.name === "runtime_reborn_target_v4");
  assert.match(rebornTargetQuery?.text ?? "", /JOIN data\.run_agent_registrations b/u);
  assert.doesNotMatch(rebornTargetQuery?.text ?? "", /agent_profiles/u);
});

test("a malformed kill-target cursor is rejected", async () => {
  await assert.rejects(runtime([]).listChannelAgentKillTargets({ requestId: "kill",
    channelId: "channel-1", actorUserId: "user-1", cursor: "broken" }), { code: "invalid_runtime_request", status: 400 });
});

test("diagnostics read a Human's Channel, and an Agent's only with its exact proof", async () => {
  const queries = [];
  const report = await runtime(queries).invocationDiagnostics({ requestId: "diag", channelId: "channel-1",
    actorUserId: "user-1" });
  assert.equal(report.schemaVersion, 1);
  assert.ok(queries.some(query => query.name === "runtime_diagnostic_recent_messages_v1"));

  const proof = { agentId: "instance-1", runId: "run-1", instanceId: "instance-1", executionKey: "execution-1",
    channelId: "channel-1", spaceId: "space-1" };
  const own = await runtime([]).invocationDiagnostics({ requestId: "diag", runId: "run-1", actorUserId: "user-1",
    agentProof: proof });
  assert.equal(own.run.runId, "run-1");
  for (const reader of [{ actorUserId: "user-1", agentProof: { ...proof, executionKey: "stale" } },
    { actorUserId: "intruder", agentProof: proof }]) {
    await assert.rejects(runtime([]).invocationDiagnostics({ requestId: "diag", runId: "run-1", ...reader }),
      { code: "forbidden", status: 403 });
  }
  for (const selection of [{ channelId: "channel-1" }, { runId: "run-2" }]) {
    const selected = [];
    await runtime(selected).invocationDiagnostics({ requestId: "diag", ...selection, actorUserId: "user-1",
      agentProof: proof });
    assert.ok(selected.some(query => query.name === "runtime_diagnostic_caller_v2"));
    assert.ok(selected.some(query => query.name === "channel_capability_runtime_history_read_v3"));
  }
});

test("registered Run diagnostics carry the Instance identity and registration name", async () => {
  const { run } = await runtime([]).invocationDiagnostics({ requestId: "diag", runId: "run-1", actorUserId: "user-1" });
  assert.equal(run.instanceId, "instance-1");
  assert.equal(run.name, "Registered Codex");
  assert.equal(Object.hasOwn(run, "agentProfileId"), false);
});

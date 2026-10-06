import assert from "node:assert/strict";
import { historicalDaemonIds } from "./machine-identity.fixture.mjs";
import test from "node:test";

import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { MachineControlError, PostgresMachineControlRepository } from "../dist/machine-control.js";
import { recordingDatabase as database } from "./recording-database.fixture.mjs";

const daemon = {
  daemon_id: "daemon-1", owner_user_id: "user-1", owner_email: "one@example.com",
  machine_id: "machine-1", hostname: "host-1", display_name: null,
  status: "online", capabilities_json: [], metadata_json: {}, connection_epoch: 1,
  version: 2, created_at: new Date("2026-08-30T00:00:00.000Z"),
  updated_at: new Date("2026-08-30T00:00:01.000Z"),
};

test("enrollment migrates the exact pre-SHA daemon and keeps its epoch and recovery bindings", async () => {
  const ownerUserId = "user-1", machineId = `machine:${"b".repeat(64)}`, hostId = "Workstation";
  const { oldId, daemonId } = historicalDaemonIds(ownerUserId, machineId, hostId);
  const historical = { ...daemon, daemon_id: oldId, machine_id: machineId, hostname: hostId, connection_epoch: 19 };
  let current, recoveredId = oldId;
  const db = database(query => {
    if (query.name === "machine_control_daemon_lock_v1") return current ? [current] : [];
    if (query.name === "machine_control_legacy_key_lock_v1") return [historical];
    if (query.name === "machine_control_legacy_key_move_v1") {
      current = { ...historical, daemon_id: daemonId };
      return [current];
    }
    if (query.name === "machine_control_legacy_enrollment_move_v1") recoveredId = daemonId;
    if (query.name === "machine_control_enrollment_recovery_v1") return [{ daemon_id: recoveredId,
      owner_user_id: ownerUserId, action: "enroll", created_at: historical.created_at }];
    return [];
  });
  const input = { commandId: "enroll-old", action: "enroll", ownerUserId, ownerEmail: "one@example.com",
    machineId, hostId, daemonId, payload: {}, principal: { kind: "user", id: ownerUserId } };
  const repository = new PostgresMachineControlRepository(db);
  const first = await repository.command(input);
  assert.equal(first.daemon.id, daemonId);
  assert.equal(first.connectionEpoch, 19);
  assert.equal(first.audit.recovered, true);
  assert.deepEqual(db.calls.find(call => call.name === "machine_control_legacy_allocation_move_v1").values,
    [oldId, daemonId, ownerUserId, machineId]);
  assert.deepEqual(db.calls.find(call => call.name === "machine_control_legacy_activation_move_v1").values,
    [oldId, daemonId]);
  assert.deepEqual(await repository.command(input), first);
  assert.equal(db.calls.filter(call => call.name === "machine_control_legacy_key_move_v1").length, 1);
  for (const rows of [[{ ...historical, daemon_id: "daemon:wrong" }], [historical, historical]]) {
    const rejected = database(query => query.name === "machine_control_legacy_key_lock_v1" ? rows : []);
    await assert.rejects(new PostgresMachineControlRepository(rejected).command(input),
      error => error.code === "machine_identity_conflict");
    assert.equal(rejected.calls.some(call => call.name === "machine_control_legacy_key_move_v1"), false);
  }
  const forbidden = database(() => { throw new Error("must reject before querying"); });
  await assert.rejects(new PostgresMachineControlRepository(forbidden).command({ ...input,
    principal: { kind: "user", id: "another-user" } }), error => error.code === "forbidden");
});

test("Quota probe issuance requires a capable exact daemon epoch and a short expiry", async () => {
  const probe = { requestId: "probe-1", connectionEpoch: 1,
    targets: [{ targetId: "registration:codex", configurationDigest: "a".repeat(64) }] };
  const input = { commandId: "issue-probe", action: "issue", controlId: "probe-1", commandType: "quota_probe",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", principal: { kind: "user", id: "user-1" },
    payload: { type: "machine_quota_probe", requestId: "probe-1", probe } };
  const make = capable => database(query => query.name === "machine_control_daemon_lock_v1" ? [daemon]
    : query.name === "machine_quota_probe_epoch_v3" ? capable ? [{}] : []
    : query.name === "machine_control_issue_v1" ? [{ command_id: "probe-1" }] : []);
  const db = make(true);
  await new PostgresMachineControlRepository(db).command(input);
  const issue = db.calls.find(call => call.name === "machine_control_issue_v1");
  assert.equal(Date.parse(issue.values[7]) - Date.parse(issue.values[6]), 15000);
  assert.deepEqual(db.calls.find(call => call.name === "machine_quota_probe_epoch_v3").values,
    ["user-1", "machine-1", 1]);
  const absent = make(false);
  await assert.rejects(new PostgresMachineControlRepository(absent).command(input),
    error => error.code === "invalid_quota_probe");
  assert.equal(absent.calls.some(call => call.name === "machine_control_issue_v1"), false);
  await assert.rejects(new PostgresMachineControlRepository(make(true)).command({ ...input,
    payload: { ...input.payload, token: "must-not-be-accepted" } }), error => error.code === "invalid_quota_probe");
});

test("Quota completion cannot substitute a target, configuration or connection on replay", async () => {
  const target = { targetId: "registration:codex", configurationDigest: "a".repeat(64) };
  const probe = { requestId: "probe-1", connectionEpoch: 1, targets: [target] };
  const payload = { type: "machine_quota_probe_result", requestId: "probe-1", probe: {
    requestId: "probe-1", connectionEpoch: 1,
    results: [{ ...target, status: "unavailable", reason: "provider_unavailable" }],
  } };
  const db = database(query => query.name === "machine_control_daemon_lock_v1" ? [daemon]
    : query.name === "machine_control_complete_replay_lock_v2" ? [{ command_type: "quota_probe",
      status: "completed", payload_json: { type: "machine_quota_probe", requestId: "probe-1", probe },
      result_json: payload }] : []);
  const repository = new PostgresMachineControlRepository(db);
  const input = { commandId: "complete-probe", action: "complete", controlId: "probe-1",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", connectionEpoch: 1, eventType: "machine_quota_probe_result", payload,
    principal: machinePrincipal() };
  assert.equal((await repository.command(input)).reused, true);
  for (const patch of [{ targetId: "registration:other" }, { configurationDigest: "b".repeat(64) }]) {
    await assert.rejects(repository.command({ ...input, payload: { ...payload,
      probe: { ...payload.probe, results: [{ ...payload.probe.results[0], ...patch }] } } }),
    error => error.code === "machine_command_result_mismatch");
  }
  await assert.rejects(repository.command({ ...input, payload: { ...payload,
    probe: { ...payload.probe, connectionEpoch: 2 } } }), error => error.code === "machine_command_result_mismatch");
});

test("Quota completion records each reading in its registration's pool without anyone waiting for it", async () => {
  const configurationDigest = await digestCanonicalCloneCborV1({ kind: "registration-quota-probe",
    ownerUserId: "user-1", machineId: "machine-1", harness: "codex", environmentVersion: 4 });
  const targets = [{ targetId: "registration:codex", configurationDigest },
    { targetId: "registration:grok", configurationDigest: "b".repeat(64) }];
  const probe = { requestId: "probe-1", connectionEpoch: 1, targets };
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const payload = { type: "machine_quota_probe_result", requestId: "probe-1", probe: {
    requestId: "probe-1", connectionEpoch: 1, results: targets.map(target => ({ ...target, status: "observed",
      quotaSource: "provider_api", quotaObservedAt: observedAt, quotaUsages: [{ percent: 100, resetAt }] })),
  } };
  const relayLease = { leaseOwner: "owner-1", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1 };
  const run = success => {
    const db = database(query => query.name === "machine_control_daemon_lock_v1" ? [daemon]
      : query.name === "machine_control_complete_replay_lock_v2" ? [{ command_type: "quota_probe", status: "leased",
        payload_json: { type: "machine_quota_probe", requestId: "probe-1", probe } }]
      : query.name === "machine_control_lease_lock_v3" ? [{ command_id: "probe-1", command_type: "quota_probe",
        status: "leased", lease_owner: "owner-1", lease_generation: 1, version: 2, lease_live: true,
        payload_json: { type: "machine_quota_probe", requestId: "probe-1", probe } }]
      : query.name === "machine_control_complete_v1" ? [{ command_id: "probe-1" }]
      // grok's registration changed version after the probe was issued; its digest no longer matches.
      : query.name === "registration_quota_probe_result_target_v1" ? [{ environment_version: 4,
        quota_pool_id: `registration:machine-1:${query.values[2]}` }] : []);
    return new PostgresMachineControlRepository(db).command({ commandId: `complete-${success}`, action: "complete",
      controlId: "probe-1", ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
      hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1, eventType: "machine_quota_probe_result",
      payload: { ...payload, relayLease }, relayLease, success,
      principal: machinePrincipal() }).then(() => db);
  };
  const db = await run(true);
  const writes = db.calls.filter(call => call.name === "registration_quota_observe_v4");
  assert.equal(writes.length, 1, "only the target still at its issued configuration is recorded");
  assert.deepEqual(writes[0].values.slice(0, 4), ["user-1", "registration:machine-1:codex", 0, observedAt]);
  assert.equal(writes[0].values[4], resetAt, "an exhausted reading holds until the provider reset");
  assert.deepEqual(JSON.parse(writes[0].values[6]), [{ usedPercent: 100, resetAt }],
    "the window behind the reading is kept for the Agents page");
  assert.equal(writes[0].values[7], null, "a reading without the provider's verdict stores none");
  assert.equal((await run(false)).calls.some(call => call.name === "registration_quota_observe_v4"), false,
    "a failed probe records nothing");
});

test("Machine status validates Machine bindings and ignores hostname observations", async () => {
  const db = database(() => [{ command_type: "stop", status: "pending", payload_json: { runId: "run-1" },
    machine_id: "machine-1", hostname: "host-1" }]);
  const repository = new PostgresMachineControlRepository(db);
  const input = { requestId: "status-1", ownerUserId: "user-1", controlId: "stop-1",
    commandType: "stop", expected: { runId: "run-1" } };
  assert.equal((await repository.status(input)).status, "queued");
  assert.equal((await repository.status({ ...input, machineId: "machine-1", hostId: "host-1" })).status, "queued");
  assert.equal((await repository.status({ ...input, hostId: "renamed-host" })).status, "queued");
  for (const route of [{ machineId: "another-machine" }]) {
    await assert.rejects(repository.status({ ...input, ...route }), /bound to another route/u);
  }
  await assert.rejects(repository.status({ ...input, expected: { runId: "run-2" } }), /not the exact requested operation/u);
});

test("Machine connect establishes a fenced PostgreSQL connection epoch", async () => {
  const db = database((query) => query.name === "machine_control_daemon_create_v2"
    ? [daemon] : []);
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "connect-1", action: "connect", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", payload: {}, metadata: {}, capabilities: [],
    principal: machinePrincipal(),
  });

  assert.equal(value.connectionEpoch, 1);
  assert.equal(value.daemon.id, "daemon-1");
  assert.equal(value.daemon.connectedAt, "2026-08-30T00:00:00.000Z");
  assert.equal(db.calls.some((call) => call.name === "machine_control_replay_write_v1"), true);
});

test("Machine enroll recovers migrated audit evidence after its replay expires", async () => {
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_enrollment_recovery_v1"
      ? [{ daemon_id: "daemon-1", owner_user_id: "user-1", action: "enroll",
          event_type: null, created_at: new Date("2026-08-30T00:00:00.000Z") }]
      : []);
  const value = await new PostgresMachineControlRepository(db).command(enrollmentRequest());

  assert.equal(value.reused, true);
  assert.equal(value.daemon.id, "daemon-1");
  assert.deepEqual(value.audit, {
    commandId: "enroll-1", action: "enroll", at: "2026-08-30T00:00:00.000Z",
    persisted: true, recovered: true,
  });
  assert.equal(db.calls.some((call) => call.name === "machine_control_enrollment_audit_v1"), false);
  assert.equal(db.calls.some((call) => call.name === "machine_control_replay_write_v1"), false);
  assert.equal(db.calls.some((call) => call.name === "machine_control_daemon_update_v2"), false);
});

test("Machine enroll rejects mismatched migrated audit evidence", async () => {
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_enrollment_recovery_v1"
      ? [{ daemon_id: "another-daemon", owner_user_id: "user-1", action: "enroll",
          event_type: null, created_at: new Date("2026-08-30T00:00:00.000Z") }]
      : []);

  await assert.rejects(new PostgresMachineControlRepository(db).command(enrollmentRequest()), (error) => error instanceof MachineControlError && error.code === "idempotency_mismatch");
  assert.equal(db.calls.some((call) => call.name === "machine_control_enrollment_audit_v1"), false);
  assert.equal(db.calls.some((call) => call.name === "machine_control_replay_write_v1"), false);
});

test("Machine list emits the required public connection timestamps", async () => {
  const db = database((query) => query.name === "machine_control_list_v6"
    ? [{ ...daemon, machine_name: "Studio", active_runs: "2", auto_assign: false },
      { ...daemon, daemon_id: "daemon-2", auto_assign: null }] : []);

  const value = await new PostgresMachineControlRepository(db).list({
    requestId: "list-1", ownerUserId: "user-1",
  });

  assert.equal(value.daemons.length, 2);
  // Only a Machine kept out of automatic assignment says so.
  assert.equal(value.daemons[0].autoAssign, false);
  assert.equal(Object.hasOwn(value.daemons[1], "autoAssign"), false);
  assert.equal(value.daemons[0].connectedAt, "2026-08-30T00:00:00.000Z");
  assert.equal(value.daemons[0].lastSeenAt, "2026-08-30T00:00:01.000Z");
  assert.equal(value.daemons[0].machineName, "Studio");
  assert.equal(value.daemons[0].activeRuns, 2);
});

test("Machine claim leases queued PostgreSQL commands with exact epoch evidence", async () => {
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_claim_candidates_v6"
      ? [{ command_id: "spawn-1", command_type: "spawn", version: 1, lease_generation: null,
          payload_json: { type: "machine_spawn_agent", requestId: "spawn-1",
            spaceId: "space-1", channelId: "channel-1" } }]
      : query.name === "machine_control_claim_v2"
        ? [{ version: 2, lease_generation: 1,
            lease_until: new Date("2099-08-30T00:01:00.000Z") }]
        : []);
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "claim-1", action: "claim", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", connectionEpoch: 1, commandTypes: ["spawn"], leaseMs: 30_000,
    payload: {}, principal: machinePrincipal(),
  });

  assert.equal(value.commands.length, 1);
  assert.deepEqual(value.commands[0].payload.relayLease, {
    leaseOwner: "machine-daemon:user-1:machine-1:epoch:1",
    leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1,
  });
  assert.equal(value.commands[0].payload.spaceId, "space-1");
  assert.equal(value.commands[0].leaseUntil, "2099-08-30T00:01:00.000Z");
  const candidates = db.calls.find((call) => call.name === "machine_control_claim_candidates_v6");
  assert.match(candidates.text, /LEFT JOIN data\.agent_launches launch/u);
  assert.match(candidates.text, /'spaceId',launch\.space_id/u);
  const claim = db.calls.find((call) => call.name === "machine_control_claim_v2");
  assert.match(claim.text, /lease_until=clock_timestamp\(\)\+\(\$2::integer\*interval '1 millisecond'\)/u);
  assert.deepEqual(claim.values.slice(1), [30_000, "spawn-1", 1]);
  assert.equal(db.calls.some((call) => call.name === "machine_control_replay_write_v1"), false);
});

test("Machine renew preserves exact lease entity version across repeated heartbeats", async () => {
  const leaseOwner = "machine-daemon:user-1:machine-1:host-1:epoch:1";
  const command = leasedSpawnRow(leaseOwner);
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_lease_lock_v3"
      ? [command]
      : query.name === "machine_control_renew_v2"
        ? [{ version: 2, lease_until: new Date("2099-08-30T00:02:00.000Z") }]
        : []);
  const repository = new PostgresMachineControlRepository(db);
  const input = (commandId) => (relayCommandRequest(leaseOwner, { commandId, action: "renew", controlId: "spawn-1" }));

  await repository.command(input("renew-1"));
  await repository.command(input("renew-2"));

  const renewals = db.calls.filter((call) => call.name === "machine_control_renew_v2");
  assert.equal(renewals.length, 2);
  assert.equal(renewals.every((call) => !call.text.includes("version=version+1")), true);
  assert.equal(renewals.every((call) => call.text.includes("lease_until=clock_timestamp()")), true);
  assert.deepEqual(renewals.map((call) => call.values), [
    [60_000, "spawn-1", 2, leaseOwner],
    [60_000, "spawn-1", 2, leaseOwner],
  ]);
});

test("Machine lease liveness is decided by PostgreSQL clock evidence", async () => {
  const leaseOwner = "machine-daemon:user-1:machine-1:host-1:epoch:1";
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_lease_lock_v3"
      ? [leasedSpawnRow(leaseOwner, { lease_live: false })]
      : []);

  await assert.rejects(new PostgresMachineControlRepository(db).command(relayCommandRequest(leaseOwner, { commandId: "renew-stale-db-clock", action: "renew", controlId: "spawn-1", relayLease: {
      leaseOwner, leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1,
    } })), (error) => error instanceof MachineControlError && error.code === "machine_command_stale_lease");
  const lock = db.calls.find((call) => call.name === "machine_control_lease_lock_v3");
  assert.match(lock.text, /lease_until>clock_timestamp\(\) AND \(command_type<>'quota_probe' OR expires_at>clock_timestamp\(\)\) AS lease_live/u);
});

test("a result lands after its lease lapsed or its connection turned over, fenced by generation", async () => {
  const leaseOwner = "machine-daemon:user-1:machine-1:host-1:epoch:0";
  const issued = { type: "machine_spawn_agent", requestId: "spawn-1", runId: "run-1",
    executionKey: "execution-1", instanceId: "instance-1", channelId: "channel-1",
    agentName: "claude", identityId: "identity-1", resumeSessionKey: "resume-1" };
  const lapsed = leasedSpawnRow(leaseOwner, { payload_json: issued, lease_until: new Date("2026-09-25T21:30:00.000Z"), lease_live: false });
  const make = (command) => database((query) => query.name === "machine_control_daemon_lock_v1" ? [daemon]
    : query.name === "machine_control_complete_replay_lock_v2" || query.name === "machine_control_lease_lock_v3"
      ? [command]
    : query.name === "machine_control_complete_v1" ? [{ command_id: "spawn-1" }]
    : query.name === "machine_control_daemon_update_v2" ? [daemon] : []);
  const input = {
    commandId: "complete-spawn-late", action: "complete", controlId: "spawn-1",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1,
    eventType: "machine_spawn_result", success: false, metadata: {}, capabilities: [],
    payload: { type: "machine_spawn_result", requestId: "spawn-1", runId: "run-1",
      executionKey: "execution-1", instanceId: "instance-1", channelId: "channel-1",
      agentName: "claude", identityId: "identity-1", ok: false, error: "workspace reclaimed" },
    // Claimed on the previous connection; the daemon reconnected before the process ended.
    relayLease: { leaseOwner, leaseGeneration: 1, entityVersion: 2, daemonEpoch: 0 },
    principal: machinePrincipal(),
  };
  const db = make(lapsed);
  await new PostgresMachineControlRepository(db).command(input);
  assert.equal(db.calls.some((call) => call.name === "machine_control_complete_v1"), true,
    "nobody re-claimed it, so the process's own outcome is the command's outcome");

  const reclaimed = make({ ...lapsed, lease_generation: 2, version: 3 });
  await assert.rejects(new PostgresMachineControlRepository(reclaimed).command(input),
    (error) => error instanceof MachineControlError && error.code === "machine_command_stale_lease",
    "once re-claimed, only the new holder decides");
  assert.equal(reclaimed.calls.some((call) => call.name === "machine_control_complete_v1"), false);
});

test("Machine renew rejects immutable spawn authority mismatches before extending the lease", async () => {
  const leaseOwner = "machine-daemon:user-1:machine-1:host-1:epoch:1";
  const command = leasedSpawnRow(leaseOwner, { payload_json: {
      type: "machine_spawn_agent", requestId: "spawn-1", launchId: "launch-1",
      spaceId: "space-1",
      runId: "run-1", instanceId: "instance-1", executionKey: "execution-1",
      channelId: "channel-1", identityId: "agent-1",
      workspace: { canonicalCwd: "/workspace/one" },
    } });
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_lease_lock_v3" ? [command] : []);

  await assert.rejects(new PostgresMachineControlRepository(db).command(relayCommandRequest(leaseOwner, { commandId: "renew-mismatch", action: "renew", controlId: "spawn-1", expected: {
      launchId: "launch-1", spaceId: "space-1", runId: "run-1", instanceId: "instance-1",
      executionKey: "execution-1", channelId: "channel-1", agentId: "agent-1",
      workspaceCanonicalCwd: "/workspace/two",
    } })), (error) => error instanceof MachineControlError &&
    error.code === "machine_command_payload_mismatch");
  await assert.rejects(new PostgresMachineControlRepository(db).command(relayCommandRequest(leaseOwner, { commandId: "renew-space-mismatch", action: "renew", controlId: "spawn-1", expected: {
      launchId: "launch-1", spaceId: "space-2", runId: "run-1", instanceId: "instance-1",
      executionKey: "execution-1", channelId: "channel-1", agentId: "agent-1",
      workspaceCanonicalCwd: "/workspace/one",
    } })), (error) => error instanceof MachineControlError &&
    error.code === "machine_command_payload_mismatch");
  assert.equal(db.calls.some((call) => call.name === "machine_control_renew_v2"), false);
});

test("Machine issue_batch persists exact spawn commands and reuses identical commands", async () => {
  const rows = [1, 2, 3].map((index) => ({
    command_id: `spawn-${index}`, owner_user_id: "user-1", machine_id: "machine-1",
    hostname: "host-1", command_type: "spawn", status: "pending", result_json: null,
    created_at: new Date("2026-08-30T00:00:00.000Z"),
    payload_json: {
      type: "machine_spawn_agent", requestId: `spawn-${index}`, launchId: `launch-${index}`,
      spaceId: "space-1",
      runId: `run-${index}`, instanceId: `instance-${index}`, executionKey: `execution-${index}`,
      channelId: "channel-1", identityId: `agent-${index}`,
      workspace: { canonicalCwd: "/workspace/one" },
    },
  }));
  let insertCount = 0;
  const db = database((query) => query.name === "machine_control_issue_batch_channels_v3"
    ? [{ channel_id: "channel-1", archived_at: null }]
    : query.name === "machine_control_issue_batch_v1"
    ? (++insertCount === 1 ? rows.map((row) => ({ command_id: row.command_id })) : [])
    : batchIssueReadRows(query, rows));
  const commands = rows.map((row) => ({
    controlId: row.command_id, commandType: "spawn", payload: row.payload_json,
  }));
  const repository = new PostgresMachineControlRepository(db);
  const base = {
    action: "issue_batch", ownerUserId: "user-1", ownerEmail: "one@example.com",
    machineId: "machine-1", hostId: "host-1", daemonId: "daemon-1", payload: {}, commands,
    principal: { kind: "user", id: "user-1" },
  };
  const first = await repository.command({ ...base, commandId: "issue-batch-1" });
  const replayed = await repository.command({ ...base, commandId: "issue-batch-2" });

  assert.deepEqual(first.commands.map((entry) => entry.reused), [false, false, false]);
  assert.deepEqual(replayed.commands.map((entry) => entry.reused), [true, true, true]);
  assert.equal(db.calls.filter((call) => call.name === "machine_control_issue_batch_v1").length, 2);
  assert.equal(db.calls.filter((call) => call.name === "machine_control_run_routes_batch_v2").length, 2);
});

test("Machine issue_batch accepts the coordinator's full 100-command claim", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    command_id: `spawn-full-${index}`, owner_user_id: "user-1", machine_id: "machine-1",
    hostname: "host-1", command_type: "spawn", status: "pending", result_json: null,
    created_at: new Date("2026-08-30T00:00:00.000Z"),
    payload_json: { type: "machine_spawn_agent", requestId: `spawn-full-${index}`,
      spaceId: "space-1",
      runId: `run-full-${index}`, instanceId: `instance-full-${index}`,
      executionKey: `execution-full-${index}`, channelId: "channel-1",
      identityId: `agent-full-${index}`, workspace: { canonicalCwd: "/workspace/one" } },
  }));
  const db = database((query) => query.name === "machine_control_issue_batch_channels_v3"
    ? [{ channel_id: "channel-1", archived_at: null }]
    : query.name === "machine_control_issue_batch_v1"
    ? rows.map((row) => ({ command_id: row.command_id }))
    : batchIssueReadRows(query, rows));
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "issue-full-batch", action: "issue_batch", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", payload: {}, principal: { kind: "user", id: "user-1" },
    commands: rows.map((row) => ({ controlId: row.command_id, commandType: "spawn",
      payload: row.payload_json })),
  });
  assert.equal(value.commands.length, 100);
});

test("Machine issue_batch rejects a spawn command without Space authority", async () => {
  const db = database((query) => query.name === "machine_control_daemon_create_v2" ? [daemon] : []);
  await assert.rejects(new PostgresMachineControlRepository(db).command({
    commandId: "issue-missing-space", action: "issue_batch", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", payload: {}, principal: { kind: "user", id: "user-1" },
    commands: [{ controlId: "spawn-missing-space", commandType: "spawn", payload: {
      type: "machine_spawn_agent", requestId: "spawn-missing-space", runId: "run-1",
      instanceId: "instance-1", executionKey: "execution-1", channelId: "channel-1",
    } }],
  }), (error) => error instanceof MachineControlError && error.code === "invalid_machine_command");
  assert.equal(db.calls.some((call) => call.name === "machine_control_issue_batch_v1"), false);
});

test("Machine statusMany returns ordered durable status and rejects a payload mismatch", async () => {
  const row = {
    command_id: "spawn-1", command_type: "spawn", status: "completed",
    payload_json: { launchId: "launch-1", runId: "run-1" },
    result_json: { ok: true }, created_at: new Date("2026-08-30T00:00:00.000Z"),
    completed_at: new Date("2026-08-30T00:00:03.000Z"),
  };
  const db = database((query) => query.name === "machine_control_status_batch_v2"
    ? [row] : query.name === "machine_control_status_batch_daemon_v2" ? [daemon] : []);
  const repository = new PostgresMachineControlRepository(db);
  const value = await repository.statusMany({
    requestId: "status-many-1", ownerUserId: "user-1", machineId: "machine-1",
    hostId: "host-1", commands: [
      { controlId: "spawn-1", expected: { launchId: "launch-1", runId: "run-1" } },
      { controlId: "spawn-missing", expected: { launchId: "launch-missing" } },
    ],
  });
  assert.deepEqual(value.commands.map((entry) => entry.status), ["completed", "missing"]);
  assert.deepEqual(value.commands[0].result, { ok: true });

  await assert.rejects(repository.statusMany({
    requestId: "status-many-2", ownerUserId: "user-1", machineId: "machine-1",
    hostId: "host-1", commands: [
      { controlId: "spawn-1", expected: { launchId: "other-launch" } },
    ],
  }), (error) => error instanceof MachineControlError && error.code === "forbidden");
});

test("Machine spawn completion validates the fields its result protocol can echo", async () => {
  const leaseOwner = "machine-daemon:user-1:machine-1:host-1:epoch:1";
  const issued = {
    type: "machine_spawn_agent", requestId: "spawn-1", runId: "run-1",
    launchId: "launch-1",
    executionKey: "execution-1", instanceId: "instance-1", channelId: "channel-1",
    agentName: "codex-bobo-next", identityId: "identity-1",
    resumeSessionKey: "resume-1",
  };
  const command = leasedSpawnRow(leaseOwner, { payload_json: issued });
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_complete_replay_lock_v2"
      ? [command]
      : query.name === "machine_control_lease_lock_v3"
        ? [command]
        : query.name === "machine_control_complete_v1"
          ? [{ command_id: "spawn-1" }]
          : query.name === "machine_control_daemon_update_v2"
            ? [daemon]
            : []);

  const input = {
    commandId: "complete-spawn-1", action: "complete", controlId: "spawn-1",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1,
    eventType: "machine_spawn_result", success: true, metadata: {}, capabilities: [],
    payload: {
      type: "machine_spawn_result", requestId: "spawn-1", runId: "run-1",
      launchId: "launch-1",
      executionKey: "execution-1", instanceId: "instance-1", channelId: "channel-1",
      agentName: "codex-bobo-next", identityId: "identity-1", ok: true, pid: 123,
    },
    relayLease: { leaseOwner, leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1 },
    principal: machinePrincipal(),
  };
  const value = await new PostgresMachineControlRepository(db).command(input);

  assert.equal(value.action, "complete");
  assert.equal(db.calls.some((call) => call.name === "machine_control_complete_v1"), true);

  const mismatchDb = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_complete_replay_lock_v2" ? [command]
    : query.name === "machine_control_lease_lock_v3" ? [command] : []);
  await assert.rejects(
    new PostgresMachineControlRepository(mismatchDb).command({
      ...input,
      commandId: "complete-spawn-mismatch",
      payload: { ...input.payload, identityId: "other-identity" },
    }),
    (error) => error instanceof MachineControlError &&
      error.code === "machine_command_result_mismatch",
  );
});

test("Machine completion replay acknowledges an identical durable result after reconnect", async () => {
  const issued = {
    type: "machine_spawn_agent", requestId: "spawn-1", runId: "run-1", launchId: "launch-1",
    executionKey: "execution-1", instanceId: "instance-1", channelId: "channel-1",
    agentName: "codex-bobo-next", identityId: "identity-1",
  };
  const result = {
    type: "machine_spawn_result", requestId: "spawn-1", runId: "run-1", launchId: "launch-1",
    executionKey: "execution-1", instanceId: "instance-1", channelId: "channel-1",
    agentName: "codex-bobo-next", identityId: "identity-1", ok: true, pid: 123,
  };
  const connected = { ...daemon, connection_epoch: 2 };
  const completed = {
    command_id: "spawn-1", owner_user_id: "user-1", machine_id: "machine-1", hostname: "host-1",
    command_type: "spawn", payload_json: issued, status: "completed", result_json: result,
  };
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [connected]
    : query.name === "machine_control_replay_read_v1"
      ? [{ request_digest: "old-epoch-digest", result_json: { action: "complete" } }]
      : query.name === "machine_control_complete_replay_lock_v2"
        ? [completed]
        : query.name === "machine_control_daemon_update_v2"
          ? [connected]
          : query.name === "machine_control_run_route_read_v2"
            ? [{ channel_id: "channel-1" }]
            : []);
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "machine-complete:spawn-1", action: "complete", controlId: "spawn-1",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 2,
    eventType: "machine_spawn_result", success: true, metadata: {}, capabilities: [], payload: result,
    relayLease: { leaseOwner: "old", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1 },
    principal: machinePrincipal(),
  });

  assert.equal(value.reused, true);
  assert.equal(value.runLifecycleChannelId, "channel-1");
  assert.equal(db.calls.some((call) => call.name === "machine_control_lease_lock_v3"), false);
  assert.equal(db.calls.some((call) => call.name === "machine_control_complete_v1"), false);
  assert.equal(db.calls.some((call) => call.name === "machine_control_replay_write_v1"), false);
});

test("Machine exact completion replay crosses a newer daemon epoch after its ACK is lost", async () => {
  const issued = {
    type: "machine_spawn_agent", requestId: "spawn-lost-ack", runId: "run-lost-ack",
    launchId: "launch-lost-ack", executionKey: "execution-lost-ack",
    instanceId: "instance-lost-ack", channelId: "channel-1",
    agentName: "codex-bobo-next", identityId: "identity-1",
  };
  const result = {
    type: "machine_spawn_result", requestId: "spawn-lost-ack", runId: "run-lost-ack",
    launchId: "launch-lost-ack", executionKey: "execution-lost-ack",
    instanceId: "instance-lost-ack", channelId: "channel-1",
    agentName: "codex-bobo-next", identityId: "identity-1", ok: false,
    error: "connection epoch changed before agent spawn",
    relayLease: { leaseOwner: "old", leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1 },
  };
  const leased = {
    command_id: "spawn-lost-ack", owner_user_id: "user-1", machine_id: "machine-1",
    hostname: "host-1", command_type: "spawn", payload_json: issued, status: "leased",
    lease_owner: "old", lease_generation: 1, version: 2, lease_live: true,
  };
  let connectionEpoch = 1;
  let storedReplay;
  const db = database((query) => {
    if (query.name === "machine_control_daemon_lock_v1" ||
        query.name === "machine_control_daemon_update_v2") {
      return [{ ...daemon, connection_epoch: connectionEpoch }];
    }
    if (query.name === "machine_control_replay_read_v1") {
      return storedReplay ? [storedReplay] : [];
    }
    if (query.name === "machine_control_complete_replay_lock_v2" ||
        query.name === "machine_control_lease_lock_v3") return [leased];
    if (query.name === "machine_control_complete_v1") return [{ command_id: "spawn-lost-ack" }];
    if (query.name === "machine_control_run_route_read_v2") return [{ channel_id: "channel-1" }];
    if (query.name === "machine_control_replay_write_v1") {
      storedReplay = { request_digest: query.values[4], result_json: JSON.parse(query.values[5]) };
    }
    return [];
  });
  const repository = new PostgresMachineControlRepository(db);
  const input = {
    commandId: "daemon-complete-control:spawn-lost-ack", action: "complete",
    controlId: "spawn-lost-ack", ownerUserId: "user-1", ownerEmail: "one@example.com",
    machineId: "machine-1", hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1,
    eventType: "machine_spawn_result", success: false, metadata: {}, capabilities: [],
    payload: result, relayLease: result.relayLease,
    principal: machinePrincipal(),
  };

  await repository.command(input);
  const completionWrites = db.calls.filter((call) => call.name === "machine_control_complete_v1").length;
  connectionEpoch = 2;
  const replayed = await repository.command(input);

  assert.equal(replayed.reused, true);
  assert.equal(replayed.connectionEpoch, 1);
  assert.equal(db.calls.filter((call) => call.name === "machine_control_complete_v1").length,
    completionWrites);
  assert.equal(db.calls.at(-1).name, "machine_control_replay_read_v1");
});

test("a routed exit report is recorded for the coordinator in the report transaction", async () => {
  const report = (routed, payload) => {
    const db = database((query) => query.name === "machine_control_daemon_lock_v1" ||
        query.name === "machine_control_daemon_update_v2" ? [{ ...daemon, connection_epoch: 3 }]
      : query.name === "machine_control_run_route_read_v2" && routed ? [{ channel_id: "channel-1" }]
      : []);
    return { db, value: new PostgresMachineControlRepository(db).command({
      commandId: `exit-${routed}-${payload.ok}`, action: "report", ownerUserId: "user-1",
      ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1", hostName: "Workstation",
      daemonId: "daemon-1", connectionEpoch: 3, eventType: payload.type, metadata: {}, capabilities: [],
      payload, principal: machinePrincipal(),
    }) };
  };
  const exited = { type: "machine_run_exited", requestId: "exit-1", runId: "run-1", executionKey: "execution-1" };
  const routed = report(true, exited);
  assert.equal((await routed.value).runTerminalReportRecorded, true);
  const recorded = routed.db.calls.find((call) => call.name === "machine_run_terminal_report_record_v1");
  assert.deepEqual(recorded.values.slice(0, 9), ["run-1", "machine_run_exited", "user-1", "one@example.com",
    "machine-1", "Workstation", "channel-1", 3, "exit-1"]);
  assert.ok(routed.db.calls.indexOf(recorded) < routed.db.calls.findIndex((call) =>
    call.name === "machine_control_replay_write_v1"), "recorded before the report's replay commits");

  // Without a route nothing can finalize it; the report still commits and is answered.
  const unrouted = report(false, exited);
  assert.equal((await unrouted.value).runTerminalReportRecorded, undefined);
  assert.equal(unrouted.db.calls.some((call) => call.name === "machine_run_terminal_report_record_v1"), false);
});

test("Machine stop issue persists a canonical lifecycle route for legacy ghosts", async () => {
  const db = database((query) => query.name === "machine_control_issue_v1"
    ? [{ command_id: "stop-1" }]
    : query.name === "machine_control_run_route_v2"
      ? [{ run_id: "run-1" }]
      : query.name === "machine_control_daemon_create_v2"
        ? [daemon]
        : []);
  await new PostgresMachineControlRepository(db).command({
    commandId: "issue-stop-1", action: "issue", controlId: "stop-1", commandType: "stop",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1",
    payload: { type: "machine_stop_agent", requestId: "stop-1", runId: "run-1",
      channelId: "channel-1", agentId: "agent-1" },
    principal: { kind: "user", id: "user-1" },
  });

  const route = db.calls.find((call) => call.name === "machine_control_run_route_v2");
  assert.deepEqual(route.values.slice(0, 6), [
    "run-1", "user-1", "machine-1", "host-1", "channel-1", "stop-1",
  ]);
  assert.equal(route.values[7], false);
});

test("Complete snapshots fan out to reported and recently reported Run routes only", async () => {
  const capturedAt = "2026-09-15T12:00:00.000Z";
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_daemon_update_v2"
      ? [daemon]
      : query.name === "machine_control_snapshot_routes_v3"
        ? [{ channel_id: "channel-live" }]
        : []);
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "snapshot-1", action: "report", eventType: "machine_run_snapshot",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1, metadata: {}, capabilities: [],
    payload: { type: "machine_run_snapshot", snapshotComplete: true, capturedAt,
      registryConnectionEpoch: 1, registrySequence: 4,
      runs: [{ runId: "run-live", executionKey: "exec-live" }] },
    principal: machinePrincipal(),
  });

  assert.deepEqual(value.runLifecycleChannelIds, ["channel-live"]);
  const reported = db.calls.find((call) => call.name === "machine_control_route_reported_v2");
  assert.deepEqual(reported.values.slice(1), ["user-1", "machine-1", ["run-live"]]);
  const routes = db.calls.find((call) => call.name === "machine_control_snapshot_routes_v3");
  assert.deepEqual(routes.values, ["user-1", "machine-1", ["run-live"],
    "2026-09-15T11:45:00.000Z"]);
});

test("Partial snapshots reach only the Channels of the Runs they name, and bind resources to the connection", async () => {
  const observedAt = new Date(Date.now() - 1_000).toISOString();
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_daemon_update_v2"
      ? [daemon]
      : query.name === "machine_control_route_progress_v2"
        ? [{ channel_id: "channel-b" }, { channel_id: "channel-a" }, { channel_id: "channel-b" }]
        : []);
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "progress-1", action: "report", eventType: "machine_run_snapshot",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1, metadata: {}, capabilities: [],
    payload: { type: "machine_run_snapshot", snapshotComplete: false,
      registryConnectionEpoch: 1, registrySequence: 5,
      machineResources: { observedAt, cpuLogicalCount: 8 },
      runs: [{ runId: "run-a", executionKey: "exec-a" }, { runId: "run-b", executionKey: "exec-b" }] },
    principal: machinePrincipal(),
  });

  assert.deepEqual(value.runLifecycleChannelIds, ["channel-a", "channel-b"]);
  const touched = db.calls.find((call) => call.name === "machine_control_route_progress_v2");
  assert.deepEqual(touched.values.slice(1), ["user-1", "machine-1", ["run-a", "run-b"]]);
  assert.equal(db.calls.some((call) => call.name === "machine_control_snapshot_routes_v3"), false);
  const resources = db.calls.find((call) => call.name === "machine_resource_observation_v2");
  assert.deepEqual(JSON.parse(resources.values[2]), { observedAt, cpuLogicalCount: 8, connectionEpoch: 1 });
});

test("Snapshots persist a valid harness inventory for their connection and drop an invalid one", async () => {
  const capturedAt = new Date(Date.now() - 1_000).toISOString();
  async function report(harnessInventory) {
    const db = database((query) => query.name === "machine_control_daemon_lock_v1" ||
      query.name === "machine_control_daemon_update_v2" ? [daemon] : []);
    await new PostgresMachineControlRepository(db).command({
      commandId: `inventory-${crypto.randomUUID()}`, action: "report", eventType: "machine_run_snapshot",
      ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
      hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1, metadata: {}, capabilities: [],
      payload: { type: "machine_run_snapshot", snapshotComplete: false,
        registryConnectionEpoch: 1, registrySequence: 6, harnessInventory, runs: [] },
      principal: machinePrincipal(),
    });
    return db.calls.find((call) => call.name === "machine_harness_inventory_observation_v1");
  }
  const inventory = { schemaVersion: 1, capturedAt, items: [
    { id: "claude", installed: true, path: "/usr/local/bin/claude", version: "2.1.0", probeStatus: "ok", extra: "x" },
    { id: "goose", installed: false, probeStatus: "missing" },
  ] };
  const stored = await report(inventory);
  assert.deepEqual(stored.values.slice(0, 2), ["daemon-1", 1]);
  assert.match(stored.text, /capabilities_json \? 'machine_harness_inventory_v1'/u);
  assert.equal(stored.values[3], capturedAt);
  assert.equal(JSON.parse(stored.values[2]).items[0].extra, undefined);
  assert.equal(await report({ ...inventory, schemaVersion: 2 }), undefined);
});

test("Connect keeps only a validated cached harness inventory in metadata", async () => {
  const capturedAt = new Date(Date.now() - 1_000).toISOString();
  async function connect(harnesses) {
    const db = database((query) => query.name === "machine_control_daemon_lock_v1" ||
      query.name === "machine_control_daemon_update_v2" ? [daemon] : []);
    await new PostgresMachineControlRepository(db).command({
      commandId: `connect-${crypto.randomUUID()}`, action: "connect", ownerUserId: "user-1",
      ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1", daemonId: "daemon-1",
      connectionEpoch: 1, capabilities: ["machine_harness_inventory_v1"],
      metadata: { xmatrixDaemonVersion: "0.16.600", harnesses }, payload: {},
      principal: machinePrincipal(),
    });
    const update = db.calls.find((call) => call.name === "machine_control_daemon_update_v2");
    return update && JSON.parse(update.values[5]);
  }
  const valid = await connect({ schemaVersion: 1, capturedAt, items: [{ id: "codex", installed: false, probeStatus: "missing" }] });
  assert.equal(valid.harnesses.items[0].id, "codex");
  const invalid = await connect({ schemaVersion: 1, capturedAt, items: "nope" });
  assert.equal(invalid.harnesses, undefined);
  assert.equal(invalid.xmatrixDaemonVersion, "0.16.600");
});

test("Machine stop completion rejects unknown cleanup outcomes", async () => {
  await assert.rejects(new PostgresMachineControlRepository(database(() => [])).command({
    commandId: "complete-stop-1", action: "complete", controlId: "stop-1",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1,
    eventType: "machine_stop_result", success: true,
    payload: { type: "machine_stop_result", requestId: "stop-1", ok: true,
      cleanupReason: "unknown" }, relayLease: {},
    principal: machinePrincipal(),
  }), (error) => error instanceof MachineControlError && error.code === "invalid_machine_command");
});

test("an older daemon's host-command approval notice is refused, and nothing is recorded", async () => {
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_control_daemon_update_v2" ? [daemon] : []);
  await assert.rejects(new PostgresMachineControlRepository(db).command({
    commandId: "notice-1", action: "report", eventType: "machine_request_notice",
    ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1",
    hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1, metadata: {},
    capabilities: [], principal: machinePrincipal(),
    payload: { channelId: "channel-1", body: "Approval requested", metadata: {
      source: "daemon-request-broker", requestBroker: { phase: "pending",
        daemonRequestId: "request-1", requestedSecrets: [] },
    } },
  }), (error) => error.code === "host_command_requests_retired" && error.status === 410);
  assert.equal(db.calls.some((call) => call.name === "machine_control_replay_write_v1"), false);
});

test("Machine activation prepares against its provisional epoch", async () => {
  const digest = "a".repeat(64);
  const activation = {
    daemon_id: "daemon-1", transaction_id: "tx-1", transaction_nonce_sha256: "b".repeat(64),
    artifact_sha256: "c".repeat(64), source_connection_epoch: 1,
    provisional_connection_epoch: 2, phase: "recovering", expected_run_ids_json: [],
    expected_run_set_digest: digest, run_set_digest: null, prepared_receipt_id: null,
    active_fenced_receipt_id: null, active_receipt_id: null, version: 1,
    created_at: new Date("2026-08-30T00:00:00.000Z"),
    updated_at: new Date("2026-08-30T00:00:00.000Z"),
  };
  const db = database((query) => query.name === "machine_control_daemon_lock_v1"
    ? [daemon]
    : query.name === "machine_activation_lock_v1"
      ? [activation]
      : query.name === "machine_activation_prepare_v1"
        ? [{ ...activation, phase: "activation_prepared", run_set_digest: digest,
            prepared_receipt_id: `prepared:tx-1:${digest}`, version: 2 }]
        : []);
  const value = await new PostgresMachineControlRepository(db).command({
    commandId: "prepare-1", action: "activation_prepare", ownerUserId: "user-1",
    ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1",
    daemonId: "daemon-1", connectionEpoch: 2,
    payload: { transactionId: "tx-1", artifactSha256: "c".repeat(64), runSetDigest: digest,
      expectedRunIds: [], adoptedRunIds: [], naturalTerminalRunIds: [], adoptedRuns: [] },
    principal: machinePrincipal(),
  });

  assert.equal(value.activation.phase, "activation_prepared");
  assert.equal(value.connectionEpoch, 2);
});

test("Machine authority rejects cached PostgreSQL", () => {
  assert.throws(() => new PostgresMachineControlRepository({ cacheMode: "cached" }),
    (error) => error instanceof MachineControlError && error.code === "cached_authority_forbidden");
});

test("a retired Machine admits no daemon enrollment or connection; owner work still reaches it", async () => {
  const ownerUserId = "user-1", machineId = "machine-1", hostId = "host-1";
  const machine = { kind: "machine", id: `machine-daemon:${ownerUserId}:${machineId}:${hostId}`,
    ownerUserId, machineId, hostId };
  const base = { ownerUserId, ownerEmail: "one@example.com", machineId, hostId, daemonId: "daemon-1",
    payload: {}, metadata: {}, capabilities: [] };
  for (const [action, principal] of [["enroll", { kind: "user", id: ownerUserId }], ["connect", machine],
    ["recover_connect", machine]]) {
    const db = database(query => query.name === "machine_control_retired_v1" ? [{ "?column?": 1 }]
      : query.name === "machine_control_daemon_lock_v1" ? [daemon] : []);
    await assert.rejects(new PostgresMachineControlRepository(db).command({ ...base,
      commandId: `${action}-1`, action, principal }), error => error instanceof MachineControlError &&
      error.code === "machine_retired" && error.status === 410 && /xmatrix login/u.test(error.message));
    assert.deepEqual(db.calls.find(call => call.name === "machine_control_retired_v1").values, [ownerUserId, machineId]);
    assert.equal(db.calls.some(call => call.name === "machine_control_daemon_lock_v1"), false,
      `${action} is refused before the daemon row is read or written`);
  }
  // Stops the Channel coordinator issues for the removed Machine's Runs are not refused.
  const issued = database(query => query.name === "machine_control_daemon_lock_v1" ? [daemon]
    : query.name === "machine_control_issue_v1" ? [{ command_id: "stop-1" }] : []);
  await new PostgresMachineControlRepository(issued).command({ ...base, commandId: "stop-1", action: "issue",
    controlId: "stop-1", commandType: "stop", principal: { kind: "user", id: ownerUserId },
    payload: { type: "machine_stop_agent", requestId: "stop-1", runId: "run-1", instanceId: "instance-1" } })
    .catch(() => {});
  assert.equal(issued.calls.some(call => call.name === "machine_control_retired_v1"), false);
});

test("required naming rejects enrollment before daemon mutation and never uses the reported hostname", async () => {
  const db = database(() => []);
  const input = { commandId: "enroll-unnamed", action: "enroll", ownerUserId: "owner", ownerEmail: "owner@example.test",
    machineId: `machine:${"d".repeat(64)}`, daemonId: "daemon:chosen", hostId: "hostname-is-not-a-name", payload: {},
    principal: { kind: "user", id: "owner" }, requireMachineName: true };
  await assert.rejects(new PostgresMachineControlRepository(db).command(input), error => error.code === "machine_name_required");
  assert.deepEqual(db.calls.find(query => query.name === "machine_name_require_v1").values, ["owner",input.machineId]);
  assert.equal(db.calls.some(query => query.name === "machine_names_owner_lock_v1"), false);
  assert.equal(db.calls.some(query => query.text?.includes("INSERT") || query.text?.includes("UPDATE")), false);
});

function enrollmentRequest(overrides = {}) {
  return { commandId: "enroll-1", action: "enroll", ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1", daemonId: "daemon-1", payload: {}, metadata: {}, capabilities: [], principal: { kind: "user", id: "user-1" }, ...overrides };
}

function relayCommandRequest(leaseOwner, overrides = {}) {
  return { ownerUserId: "user-1", ownerEmail: "one@example.com", machineId: "machine-1", hostId: "host-1", daemonId: "daemon-1", connectionEpoch: 1, leaseMs: 60_000, payload: {}, relayLease: { leaseOwner, leaseGeneration: 1, entityVersion: 2, daemonEpoch: 1 }, principal: machinePrincipal(), ...overrides };
}

function leasedSpawnRow(leaseOwner, overrides = {}) {
  return { command_id: "spawn-1", owner_user_id: "user-1", machine_id: "machine-1", hostname: "host-1", command_type: "spawn", payload_json: {}, status: "leased", lease_owner: leaseOwner, lease_generation: 1, version: 2, lease_until: new Date("2099-08-30T00:01:00.000Z"), lease_live: true, ...overrides };
}

function batchIssueReadRows(query, rows) {
  if (query.name === "machine_control_issue_batch_read_v1") return rows;
  if (query.name === "machine_control_run_routes_batch_v2") return rows.map(row => ({ run_id: row.payload_json.runId }));
  if (query.name === "machine_control_daemon_create_v2") return [daemon];
  return [];
}

function machinePrincipal(overrides = {}) {
  return { kind: "machine", id: "machine-daemon:user-1:machine-1:host-1", ownerUserId: "user-1", machineId: "machine-1", hostId: "host-1", ...overrides };
}

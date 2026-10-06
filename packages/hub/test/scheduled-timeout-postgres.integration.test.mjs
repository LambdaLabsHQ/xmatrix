import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { scratchAutomationRepository, applyMigrations, createCanonicalTables, withScratchDatabase } from "./support/postgres-scratch-database.mjs";
import {
  PostgresScheduleOccurrenceLifecycle,
} from "../src/postgres-automation-authority.ts";
import { reapSpaceAutomationRuns } from "../src/space-automation-alarm.ts";
const connectionString = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = connectionString || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true"
  ? test : test.skip;
const now = "2026-09-12T21:20:00.000Z";

integration("scheduled timeout immediately cancels execution; cleanup remains bounded and independent", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  await withScratchDatabase(connectionString, "scheduled_timeout", async ({ client, concurrent, url }) => {
    await client.query("SET TIME ZONE 'UTC'");
    await concurrent.query("SET TIME ZONE 'UTC'");
    await client.query("CREATE SCHEMA data");
    await client.query("CREATE SCHEMA control");
    await createCanonicalTables(client, [
      ["0007_expand_space_control_facts.sql", ["channels", "space_members", "channel_access"]],
      ["0002_expand_data_substrate.sql", ["outbox"]],
      ["0011_expand_space_control_authority.sql", ["space_control_heads"]],
      ["0009_expand_remaining_control_facts.sql", ["runs", "instances", "trace_access_grants", "scheduled_tasks", "scheduled_task_occurrences"]],
      ["0036_expand_agent_launches.sql", ["agent_launches"]],
      ["0015_expand_user_agent_control_facts.sql", ["machine_daemons", "machine_daemon_commands", "machine_run_routes"]],
    ]);
    await applyMigrations(client, ["0020_expand_scheduled_occurrence_authority.sql"]);
    // Channel capability SQL also recognises registered Agent Instances.
    await applyMigrations(client, ["0016_expand_scoped_control_command_replays.sql", "0019_expand_machine_command_authority.sql",
      "0076_expand_nullable_profile_references.sql",
      "0059_expand_agent_registration_keys.sql", "0068_expand_registration_run_bindings.sql",
      "0080_contract_automation_storage_names.sql"]);
    await applyMigrations(client, ["0001_expand_space_placement.sql", "0025_expand_entity_space_routes.sql"]);
    await client.query(`INSERT INTO control.postgres_shards VALUES ('test','active','test',$1,$1)`, [now]);
    await client.query(`INSERT INTO control.space_placement
      VALUES ('space','test',1,'active',NULL,'test',$1,$1)`, [now]);
    const repo = scratchAutomationRepository(client);
    const other = scratchAutomationRepository(concurrent);
    async function fixture(id, options = {}) {
      await client.query(`INSERT INTO data.channels
        (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
        VALUES ($1,$2,$1,$1,'open',$1,1,'2026-08-01','2026-08-01')`, [id, options.space ?? "space"]);
      await client.query(`INSERT INTO data.runs
        (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
        VALUES ($1,'owner',$1,$2,1,$3,'2026-08-01','2026-08-01')`,
      [id, options.runStatus ?? "starting", { machineId: "machine", hostId: "host",
        ...(options.key === false ? {} : { executionKey: `key-${id}` }) }]);
      await client.query(`INSERT INTO data.automations
        (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,last_run_id,created_at,updated_at)
        VALUES ($1,'owner',$1,'2026-09-12T22:00:00Z',true,1,'{"intervalMinutes":30}',$1,'2026-08-01','2026-08-01')`, [id]);
      await client.query(`INSERT INTO data.automation_occurrences
        (occurrence_id,automation_id,automation_version,owner_user_id,scheduled_for,status,attempts,next_attempt_at,
          run_id,instance_id,control_id,error_code,created_at,updated_at,finished_at,delivery_kind,
          execution_timeout_ms,execution_deadline_at)
        VALUES ($1,$1,1,'owner','2026-08-01','dispatched',$2,'2026-08-01',$1,$1,$1,$3,
          '2026-08-01','2026-08-01',$4,'agent_run',1800000,$5)`,
      [id, options.attempts ?? 1, options.code === undefined ? "scheduled_run_timeout" : options.code,
        options.finished ? "2026-08-02" : null, options.deadline ?? "2026-08-01"]);
    }
    await fixture("legacy");
    await fixture("terminal", { runStatus: "completed" });
    await fixture("finished", { finished: true });
    await fixture("future", { code: null, deadline: "2026-09-13" });
    await fixture("elsewhere", { space: "another-space" });
    assert.equal(await repo.nextChannelAutomationWakeAt({ requestId: randomUUID(), channelId: "legacy" }),
      "2026-08-01T00:00:00.000Z");
    const claim = () => ({ requestId: randomUUID(), now, spaceId: "space" });
    await Promise.all([repo.cancelExpiredExecutions(claim()), other.cancelExpiredExecutions(claim())]);
    const state = async id => (await client.query(`SELECT o.status,o.error_code,o.finished_at,
      r.status AS run_status,r.metadata_json FROM data.automation_occurrences o
      JOIN data.runs r ON r.run_id=o.run_id WHERE o.occurrence_id=$1`, [id])).rows[0];
    const cancelled = await state("legacy");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.run_status, "failed");
    assert.equal(cancelled.error_code, "scheduled_run_timed_out");
    assert.ok(cancelled.finished_at);
    assert.equal(cancelled.metadata_json.daemonTerminalEvidence, undefined);
    assert.equal(cancelled.metadata_json.executionCancellation.processCleanup.status, "pending");
    for (const id of ["future", "elsewhere"]) assert.equal((await state(id)).status, "dispatched");
    const [left, right] = await Promise.all([repo.claimTimeoutStops(claim()), other.claimTimeoutStops(claim())]);
    const claims = [...left, ...right];
    assert.equal(claims.length, 1);
    assert.equal(claims[0].id, "legacy");
    assert.equal(claims[0].attempts, 1, "cleanup has its own budget");
    assert.equal((await repo.claimTimeoutStops(claim())).length, 0, "backoff blocks immediate reclaim");
    const lifecycle = new PostgresScheduleOccurrenceLifecycle({
      RELAY_POSTGRES: { connectionString: "unused" }, RELAY_POSTGRES_SHARD_ID: "test",
    }, undefined, { repositories: [repo], spaceId: "space" });
    const stops = [];
    await lifecycle.reapExpiredRuns(new Date("2026-09-12T21:21:00Z"), async stop => stops.push(stop));
    assert.equal(stops[0].controlId, "scheduled:cancel-stop:legacy:2");
    assert.equal(stops[0].executionKey, "key-legacy");
    await repo.recordTimeout({ requestId: randomUUID(), occurrenceId: "legacy", taskId: "legacy",
      runId: "legacy", now, expectedAttempts: 1, code: "scheduled_run_timeout_unroutable", message: "stale" });
    assert.equal((await state("legacy")).metadata_json.executionCancellation.processCleanup.status, "pending");
    // Simulate only the cleanup acknowledgement here; actual authenticated
    // late spawn/exit/stop report behavior is covered by lifecycle regressions.
    await client.query(`UPDATE data.runs SET metadata_json=jsonb_set(metadata_json,
      '{executionCancellation,processCleanup,status}','"confirmed"') WHERE run_id='legacy'`);
    await repo.recordTimeout({ requestId: randomUUID(), occurrenceId: "legacy", taskId: "legacy",
      runId: "legacy", now, expectedAttempts: 2, code: "scheduled_run_timeout_retry", message: "late failure" });
    assert.equal((await state("legacy")).metadata_json.executionCancellation.processCleanup.status, "confirmed");

    await fixture("no-key", { key: false });
    await fixture("exhausted", { attempts: 8, code: "scheduled_run_timeout_stop_failed" });
    const rejectedStops = [];
    await lifecycle.reapExpiredRuns(new Date("2026-09-12T21:25:00Z"), async stop => rejectedStops.push(stop));
    assert.deepEqual(rejectedStops.map(stop => stop.occurrence.id), ["exhausted"]);
    assert.equal((await state("no-key")).metadata_json.executionCancellation.processCleanup.status, "unroutable");
    assert.ok((await state("no-key")).finished_at, "missing cleanup route cannot hold occupancy");
    assert.ok((await state("exhausted")).finished_at, "legacy exhausted attempts cannot hold occupancy");
    for (let attempt = 1; attempt <= 8; attempt++) {
      await lifecycle.reapExpiredRuns(new Date(Date.parse(now) + attempt * 60 * 60_000), async () => {
        throw new Error("transport unavailable");
      });
    }
    assert.equal((await state("exhausted")).metadata_json.executionCancellation.processCleanup.status, "unconfirmed");
    assert.equal((await state("exhausted")).error_code, "scheduled_run_timed_out");
    assert.equal((await state("exhausted")).metadata_json.daemonTerminalEvidence, undefined);
    await fixture("dispatch-fails");
    await lifecycle.reapExpiredRuns(new Date("2026-09-12T21:27:00Z"), async () => {
      throw new Error("transport unavailable");
    });
    assert.equal((await state("dispatch-fails")).status, "cancelled");
    assert.equal((await state("dispatch-fails")).metadata_json.executionCancellation.processCleanup.errorCode,
      "scheduled_run_timeout_retry");
    await client.query(`UPDATE data.runs SET metadata_json=jsonb_set(metadata_json,
      '{executionCancellation,processCleanup,status}','"confirmed"') WHERE run_id='dispatch-fails'`);

    // Exercise the production scheduler callback and responsibility router,
    // not just a stubbed issueStop callback.
    await client.query("ALTER TABLE data.machine_daemons ADD COLUMN hostname text");
    await client.query("ALTER TABLE data.machine_daemons ALTER COLUMN host_id DROP NOT NULL");
    for (const table of ["machine_run_routes", "machine_daemon_commands"]) {
      await client.query(`ALTER TABLE data.${table} ALTER COLUMN host_id DROP NOT NULL`);
      await client.query(`ALTER TABLE data.${table} ADD COLUMN hostname text`);
    }
    await fixture("routed-stop");
    await client.query(`INSERT INTO data.machine_run_routes
      (run_id,owner_user_id,machine_id,hostname,channel_id,execution_key,created_at,updated_at)
      VALUES ('routed-stop','owner','machine','host','routed-stop','key-routed-stop',$1,$1)`, [now]);
    const wakes = [];
    const env = {
      RELAY_POSTGRES: { connectionString: url }, RELAY_POSTGRES_SHARD_ID: "test",
      RELAY_RUNTIME: {
        idFromName: value => value,
        get: cell => ({ async fetch(request) {
          wakes.push({ cell, ...await request.json() });
          assert.equal((await client.query(`SELECT status FROM data.machine_daemon_commands
            WHERE command_id='scheduled:cancel-stop:routed-stop:1'`)).rows[0]?.status, "pending",
          "reverse wake follows the durable PostgreSQL commit");
          return Response.json({ ok: true });
        } }),
      },
    };
    await reapSpaceAutomationRuns(env, new Date("2026-09-12T21:27:01Z"), lifecycle);
    const routed = (await client.query(`SELECT owner_user_id,machine_id,hostname,command_type,payload_json,status
      FROM data.machine_daemon_commands WHERE command_id='scheduled:cancel-stop:routed-stop:1'`)).rows;
    assert.equal(routed.length, 1);
    assert.deepEqual(routed[0], {
      owner_user_id: "owner", machine_id: "machine", hostname: "host", command_type: "stop", status: "pending",
      payload_json: { type: "machine_stop_agent", requestId: "scheduled:cancel-stop:routed-stop:1",
        runId: "routed-stop", executionKey: "key-routed-stop", agentId: "routed-stop", instanceId: "routed-stop",
        reason: "scheduled_execution_timeout", worktreeDisposition: "retain" },
    });
    // One wake reaches every cell that may hold the owner's daemon socket.
    assert.deepEqual(wakes.map(wake => wake.cell).sort(), ["cell-0", "user-owner"]);
    assert.ok(wakes.every(wake => wake.ownerUserId === "owner" && wake.machineId === "machine" &&
      wake.hostId === "host"));
    const replay = (await client.query(`SELECT result_json FROM control.scoped_control_command_replays
      WHERE command_id='scheduled:cancel-machine-stop:routed-stop:1'`)).rows[0].result_json;
    assert.equal(replay.runLifecycleChannelId, "routed-stop", "completion stays routed to the original Run");
    const pendingStop = (await client.query(`SELECT error_code,finished_at FROM data.automation_occurrences
      WHERE occurrence_id='routed-stop'`)).rows[0];
    assert.equal(pendingStop.error_code, "scheduled_run_timed_out");
    assert.ok(pendingStop.finished_at, "execution cancellation is separate from process termination");
    await reapSpaceAutomationRuns(env, new Date("2026-09-12T21:27:01Z"), lifecycle);
    assert.equal(wakes.length, 2, "the occurrence retry fence suppresses an immediate second dispatch");
    await client.query(`UPDATE data.runs SET metadata_json=jsonb_set(metadata_json,
      '{executionCancellation,processCleanup,status}','"confirmed"') WHERE run_id='routed-stop'`);

    for (let index = 0; index < 6; index++) await fixture(`bounded-${index}`);
    await concurrent.query("BEGIN");
    await concurrent.query("SELECT run_id FROM data.runs WHERE run_id='bounded-0' FOR UPDATE");
    await repo.cancelExpiredExecutions({ ...claim(), now: "2026-09-12T21:28:00Z" });
    const batch = await repo.claimTimeoutStops({ ...claim(), now: "2026-09-12T21:28:00Z" });
    assert.equal(batch.length, 4);
    assert.ok(batch.every(value => value.id !== "bounded-0"));
    await repo.cancelExpiredExecutions({ ...claim(), now: "2026-09-12T21:28:00Z" });
    assert.equal((await repo.claimTimeoutStops({ ...claim(), now: "2026-09-12T21:28:00Z" })).length, 1);
    await concurrent.query("COMMIT");
    await repo.cancelExpiredExecutions({ ...claim(), now: "2026-09-12T21:28:00Z" });
    const unlocked = await repo.claimTimeoutStops({ ...claim(), now: "2026-09-12T21:28:00Z" });
    assert.deepEqual(unlocked.map(value => value.id), ["bounded-0"]);
    await exerciseLegacyExhaustedCancellation(client, url);
    await exerciseOwnerCancellation(client, repo, other, fixture);
  });
});

async function exerciseLegacyExhaustedCancellation(client, connectionString) {
  // A legacy occurrence that exhausted its stop attempts in another Space is
  // cancelled by the generic deadline path through a real PostgreSQL lifecycle.
  const spaceId = "legacy-exhausted-space";
  const runId = "legacy-exhausted-run";
  const occurrenceId = "legacy-exhausted-occurrence";
  await client.query(`INSERT INTO control.space_placement
    VALUES ($1,'test',1,'active',NULL,'test',$2,$2)`, [spaceId, now]);
  await client.query(`INSERT INTO data.channels
    (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
    VALUES ('legacy-exhausted-channel',$1,'fixture','fixture','open','fixture',1,$2,$2)`, [spaceId, now]);
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,'legacy-owner','legacy-exhausted-channel','starting',1,$2,$3,$3)`,
  [runId, { machineId: "legacy-machine", hostId: "legacy-host", executionKey: "synthetic-original-key" }, now]);
  await client.query(`INSERT INTO data.automations
    (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,last_run_id,created_at,updated_at)
    VALUES ('legacy-exhausted-task','legacy-owner','legacy-exhausted-channel',$1,true,1,'{}',$2,$1,$1)`,
  [now, runId]);
  await client.query(`INSERT INTO data.automation_occurrences
    (occurrence_id,automation_id,automation_version,owner_user_id,scheduled_for,status,attempts,next_attempt_at,
      run_id,instance_id,control_id,error_code,created_at,updated_at,delivery_kind,
      execution_timeout_ms,execution_deadline_at)
    VALUES ($1,'legacy-exhausted-task',1,'legacy-owner',$2,'dispatched',8,$2,$3,'legacy-instance','original-spawn',
      'scheduled_run_timeout_stop_failed',$2,$2,'agent_run',1800000,'2026-08-24T07:42:42.932Z')`,
  [occurrenceId, now, runId]);
  const env = {
    RELAY_POSTGRES: { connectionString }, RELAY_POSTGRES_SHARD_ID: "test",
  };
  const lifecycle = new PostgresScheduleOccurrenceLifecycle(env, undefined, { spaceId });
  await lifecycle.reapExpiredRuns(new Date("2026-09-13T06:00:00Z"), async () => {});
  const run = (await client.query("SELECT * FROM data.runs WHERE run_id=$1", [runId])).rows[0];
  const occurrence = (await client.query("SELECT * FROM data.automation_occurrences WHERE occurrence_id=$1",
    [occurrenceId])).rows[0];
  assert.equal(run.status, "failed");
  assert.equal(occurrence.status, "cancelled");
  assert.ok(occurrence.finished_at);
  assert.equal(run.metadata_json.daemonTerminalEvidence, undefined);
  assert.equal(run.metadata_json.executionCancellation.reason, "timeout");
}

async function exerciseOwnerCancellation(client, repo, other, fixture) {
  await client.query(`INSERT INTO data.space_members
    (space_id,user_id,role,version,created_at,updated_at)
    VALUES ('space','owner','owner',1,$1,$1)`, [now]);
  await client.query(`INSERT INTO data.space_control_heads VALUES ('space',0,$1)`, [now]);
  await fixture("owner-cancel", { deadline: "2026-09-14" });
  const input = { commandId: randomUUID(), kind: "scheduled_execution_cancel",
    automationId: "owner-cancel", runId: "owner-cancel", actorUserId: "owner", at: now,
    principal: { kind: "user", id: "owner" } };
  await assert.rejects(repo.mutate({ ...input, principal: { kind: "agent", id: "profile" } }), /Human|Agent/);
  await assert.rejects(repo.mutate({ ...input, actorUserId: "stranger",
    principal: { kind: "user", id: "stranger" } }), /not found/);
  await assert.rejects(repo.mutate({ ...input, runId: "elsewhere" }), /not found/);
  const [first, concurrent] = await Promise.all([repo.mutate(input), other.mutate(input)]);
  assert.equal(first.status, "cancelled");
  assert.equal(concurrent.status, "cancelled");
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM control.scoped_control_command_replays
    WHERE command_id=$1`, [input.commandId])).rows[0].n, 1);
  const row = (await client.query(`SELECT o.*,r.status AS run_status,r.metadata_json
    FROM data.automation_occurrences o JOIN data.runs r ON r.run_id=o.run_id
    WHERE o.occurrence_id='owner-cancel'`)).rows[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.run_status, "failed");
  assert.equal(row.error_code, "scheduled_run_cancelled");
  assert.equal(row.metadata_json.executionCancellation.reason, "owner");
  assert.equal(row.metadata_json.daemonTerminalEvidence, undefined);
  assert.equal(JSON.stringify(first).includes("key-owner-cancel"), false);
  const before = (await client.query(`SELECT next_run_at,enabled FROM data.automations
    WHERE automation_id='owner-cancel'`)).rows[0];
  await fixture("successor", { deadline: "2026-09-14" });
  await client.query(`UPDATE data.automations SET last_run_id='successor' WHERE automation_id='owner-cancel'`);
  assert.equal((await repo.mutate({ ...input, commandId: randomUUID() })).status, "cancelled");
  assert.equal((await client.query(`SELECT status FROM data.runs WHERE run_id='successor'`)).rows[0].status, "starting");
  assert.deepEqual((await client.query(`SELECT next_run_at,enabled FROM data.automations
    WHERE automation_id='owner-cancel'`)).rows[0], before, "cancellation preserves schedule configuration");
}

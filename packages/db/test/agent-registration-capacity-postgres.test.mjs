import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { PostgresAgentEnvironmentRepository, PostgresRegistrationExecutionRepository } from "../dist/index.js";
import { upsertRegistrationQuotaObservation } from "../dist/agent-registration-quota-probe.js";


integration("parallel allocations across Spaces are unrestricted and terminal evidence closes executions", async () => {
  assert.ok(url);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  const schema = `registration_capacity_${process.pid}`;
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["0059_expand_agent_registration_keys.sql", "0065_expand_registration_environment.sql",
      "0066_expand_registration_allocations.sql", "0070_expand_registration_launch_intents.sql",
      "0071_expand_registration_quota_observations.sql", "0119_expand_registration_quota_windows.sql", "0158_expand_registration_quota_account.sql"]) await setup.query(rewrite(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")));
    await setup.query(`CREATE TABLE ${schema}.machine_daemons
      (daemon_id text,owner_user_id text,machine_id text,hostname text,status text,connection_epoch bigint)`);
    await setup.query(`CREATE TABLE ${schema}.machine_run_routes (run_id text,owner_user_id text,machine_id text,terminal_at timestamptz)`);
    await setup.query(`INSERT INTO ${schema}.machine_daemons VALUES ('daemon','owner','machine','host','online',1)`);
    await setup.query(`INSERT INTO ${schema}.agent_registrations VALUES ('owner','machine','codex',1,now(),now())`);
    const database = postgresConnections(5000, { rewrite, checkContext: context => assert.equal(context.placement, undefined) });
    const environments = new PostgresAgentEnvironmentRepository(database);
    const physicalKey = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const environment = { schemaVersion: 1, enabled: true, models: ["model"], modelAliases: { model: "provider/model" },
      description: "", availability: "unattended", maxConcurrent: 1, capabilities: [] };
    await environments.change({ key: physicalKey, actorUserId: "owner", commandId: "environment",
      expectedVersion: 0, expectedMachineVersion: 0, machineMaxConcurrent: 1, environment });
    const capacity = new PostgresRegistrationExecutionRepository(database);
    // Prelaunch probes must not let a skewed daemon clock poison the ordering
    // fence, or let delayed/expired readings replace an exhausted account.
    const quotaNow = Date.now();
    const observe = (remaining, observedOffset, expiresOffset, quotaPoolId = "probe-pool") => database.transaction({},
      tx => upsertRegistrationQuotaObservation(tx, { ownerUserId: "owner", quotaPoolId, remaining,
        observedAt: new Date(quotaNow + observedOffset).toISOString(),
        expiresAt: new Date(quotaNow + expiresOffset).toISOString(), source: "provider" }));
    const readQuota = async (quotaPoolId = "probe-pool") => (await setup.query(
      `SELECT remaining,observed_at FROM ${schema}.registration_quota_observations WHERE owner_user_id='owner' AND quota_pool_id=$1`,
      [quotaPoolId])).rows;
    await observe(0, -2000, 600000);
    await observe(100, 86400000, 172800000);
    await observe(100, -4000, 600000);
    await observe(100, -1500, -1000);
    assert.equal((await readQuota())[0].remaining, 0,
      "future, older and expired observations cannot clear exhaustion");
    await observe(70, -1000, 600000);
    assert.equal((await readQuota())[0].remaining, 70,
      "a valid newer observation still succeeds after a rejected future probe");
    await observe(100, 86400000, 172800000, "future-only");
    assert.deepEqual(await readQuota("future-only"), [], "future readings cannot seed a new quota pool");
    const reservation = (spaceId, runId) => ({ requestId: runId, key: { ...physicalKey, spaceId }, runId,
      sourceCommandId: `source-${runId}`, actorUserId: "caller", authorizationDigest: "a".repeat(64),
      requirements: { model: "model", unattended: false, requiredCapabilities: [] } });
    const cancelledBeforeReserve = reservation("a", "cancelled-before-reserve");
    await capacity.abortPreparation(cancelledBeforeReserve);
    await capacity.abortPreparation(cancelledBeforeReserve);
    await assert.rejects(() => capacity.reserve(cancelledBeforeReserve), error => error.code === "registration_preparation_aborted");
    const cancelledAfterReserve = reservation("a", "cancelled-after-reserve");
    await capacity.reserve(cancelledAfterReserve);
    await capacity.abortPreparation(cancelledAfterReserve);
    await assert.rejects(() => capacity.reserve(cancelledAfterReserve), error => error.code === "registration_preparation_aborted");
    await assert.rejects(() => capacity.abortPreparation({ ...cancelledAfterReserve, actorUserId: "other" }),
      error => error.code === "allocation_binding_conflict");
    const proposals = [reservation("a", "run-a"), reservation("b", "run-b")];
    const simultaneous = await Promise.allSettled(proposals.map(input => capacity.reserve(input)));
    assert.equal(simultaneous.filter(result => result.status === "fulfilled").length, 2);
    const index = simultaneous.findIndex(result => result.status === "fulfilled");
    const input = proposals[index], allocation = simultaneous[index].value;
    assert.equal((await capacity.reserve(input)).allocationId, allocation.allocationId);
    const admission = { requestId: "admit", key: input.key, runId: input.runId, allocationId: allocation.allocationId,
      authorizationDigest: input.authorizationDigest, daemonId: "daemon", hostId: "host", connectionEpoch: 1 };
    await assert.rejects(() => capacity.admit({ ...admission, key: { ...input.key, spaceId: "wrong" } }), error => error.code === "allocation_not_found");
    await assert.rejects(() => capacity.admit({ ...admission, connectionEpoch: 2 }), error => error.code === "allocation_daemon_reconnected");
    await assert.rejects(() => capacity.admit({ ...admission, expectedEnvironmentVersion: 99 }),
      error => error.code === "allocation_environment_mismatch");
    await assert.rejects(() => capacity.admit({ ...admission, expectedRuntimeModel: "unapproved/model" }),
      error => error.code === "allocation_model_mismatch");
    assert.equal((await capacity.admit(admission)).runtimeModel, "provider/model");
    assert.equal((await capacity.admit(admission)).reused, true);
    const continuation = { ...admission, requestId: "continue" };
    await setup.query(`UPDATE ${schema}.machine_daemons SET connection_epoch=2`);
    assert.equal((await capacity.requireContinuation(continuation)).state, "admitted",
      "a daemon reconnect does not allocate a new slot for an existing Run");
    await assert.rejects(() => capacity.requireContinuation({ ...continuation, hostId: "other-host" }),
      error => error.code === "allocation_daemon_changed");
    await assert.rejects(() => capacity.requireContinuation({ ...continuation, authorizationDigest: "b".repeat(64) }),
      error => error.code === "allocation_not_admitted");
    await setup.query(`UPDATE ${schema}.machine_daemons SET connection_epoch=1`);
    await assert.rejects(() => capacity.cancel({ ...admission, reason: "preparation_aborted" }), error => error.code === "allocation_already_admitted");
    assert.equal((await capacity.cancel({ ...admission, reason: "cancelled_before_start" })).state, "stopping");
    await assert.rejects(() => capacity.requireContinuation(continuation), error => error.code === "allocation_not_admitted");
    assert.equal((await capacity.reserve(reservation("b", "waiting"))).state, "reserved");
    await assert.rejects(() => capacity.admit(admission), error => error.code === "allocation_terminal");
    await setup.query(`INSERT INTO ${schema}.machine_run_routes VALUES ($1,'owner','machine',now())`, [input.runId]);
    assert.equal((await capacity.cancel({ ...admission, reason: "cancelled_before_start" })).state, "released",
      "authenticated terminal evidence releases the exact allocation without another reservation");
    const next = await capacity.reserve(reservation("b", "waiting"));
    await assert.rejects(() => capacity.reserve(input), error => error.code === "allocation_terminal");
    await assert.rejects(() => capacity.admit(admission), error => error.code === "allocation_terminal");
    await capacity.cancel({ requestId: "cancel-waiting", key: reservation("b", "waiting").key,
      runId: "waiting", allocationId: next.allocationId, reason: "cancelled_before_start" });
    // A pre-commit abort permits a new attempt nonce, never the predecessor.
    const abortedInput = reservation("a", "aborted"), aborted = await capacity.reserve(abortedInput);
    await capacity.cancel({ requestId: "abort", key: abortedInput.key, runId: "aborted",
      allocationId: aborted.allocationId, reason: "preparation_aborted" });
    const replacementInput = { ...abortedInput, authorizationDigest: "b".repeat(64) };
    const replacement = await capacity.reserve(replacementInput);
    assert.notEqual(replacement.allocationId, aborted.allocationId);
    assert.equal(replacement.generation, 2);
    await assert.rejects(() => capacity.admit({ ...admission, key: abortedInput.key, runId: "aborted", allocationId: aborted.allocationId }),
      error => error.code === "allocation_terminal");
    await capacity.cancel({ requestId: "cancel-replacement", key: abortedInput.key, runId: "aborted",
      allocationId: replacement.allocationId, reason: "cancelled_before_start" });
    // Legacy occupancy does not impose a parallel-launch limit.
    await setup.query(`INSERT INTO ${schema}.machine_run_routes VALUES ('legacy','owner','machine',NULL)`);
    assert.equal((await capacity.reserve(reservation("a", "after-legacy"))).state, "reserved");
    await setup.query(`UPDATE ${schema}.machine_run_routes SET terminal_at=now() WHERE run_id='legacy'`);
    const final = await capacity.reserve(reservation("a", "after-legacy"));
    await environments.change({ key: physicalKey, actorUserId: "owner", commandId: "changed-environment",
      expectedVersion: 1, expectedMachineVersion: 1, machineMaxConcurrent: 1,
      environment: { ...environment, description: "changed" } });
    await assert.rejects(() => capacity.admit({ ...admission, key: reservation("a", "after-legacy").key,
      runId: "after-legacy", allocationId: final.allocationId }), error => error.code === "allocation_environment_changed");
    // Terminal proof wins even when this allocation is beyond the bounded
    // cleanup batch; maintenance backlog cannot grant a token or consume slots.
    await capacity.cancel({ requestId: "cancel-final", key: reservation("a", "after-legacy").key,
      runId: "after-legacy", allocationId: final.allocationId, reason: "cancelled_before_start" });
    await setup.query(`INSERT INTO ${schema}.registration_execution_allocations
      (allocation_id,run_id,generation,source_command_id,actor_user_id,space_id,owner_user_id,machine_id,harness,
       authorization_digest,requirements_json,request_digest,environment_version,runtime_model,state,daemon_id,connection_epoch,admitted_at,created_at)
      SELECT 'finished-allocation-'||n,'finished-run-'||n,1,'finished-source-'||n,'caller','a','owner','machine','codex',
        repeat('a',64),$1::jsonb,repeat('a',64),1,'model','admitted','daemon',1,now(),
        '2000-01-01'::timestamptz+n*interval '1 second' FROM generate_series(1,66) n`,
    [JSON.stringify(reservation("a", "ignored").requirements)]);
    await setup.query(`INSERT INTO ${schema}.machine_run_routes
      SELECT 'finished-run-'||n,'owner','machine',now() FROM generate_series(1,66) n`);
    const finished = { ...admission, key: reservation("a", "ignored").key,
      runId: "finished-run-66", allocationId: "finished-allocation-66" };
    await assert.rejects(() => capacity.requireContinuation(finished), error => error.code === "allocation_not_admitted");
    await assert.rejects(() => capacity.admit(finished), error => error.code === "allocation_terminal");
    const recovered = await capacity.reserve(reservation("a", "after-terminal-backlog"));
    assert.equal(recovered.state, "reserved");
    await capacity.cancel({ requestId: "finish-backlog-test", key: reservation("a", "ignored").key,
      runId: "after-terminal-backlog", allocationId: recovered.allocationId, reason: "cancelled_before_start" });
    await environments.change({ key: physicalKey, actorUserId: "owner", commandId: "model-with-prototype-name",
      expectedVersion: 2, expectedMachineVersion: 1, machineMaxConcurrent: 1,
      environment: { ...environment, models: ["model", "constructor"] } });
    const special = reservation("a", "constructor-model");
    special.requirements.model = "constructor";
    assert.equal((await capacity.reserve(special)).runtimeModel, "constructor",
      "an inherited JavaScript property is not an owner-declared provider alias");
    const parallel = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      capacity.reserve(reservation(index % 2 ? "a" : "b", `parallel-${index}`))));
    assert.equal(new Set(parallel.map(item => item.allocationId)).size, 40);
    assert.ok(parallel.every(item => item.state === "reserved"));
  } finally { await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await setup.end(); }
});

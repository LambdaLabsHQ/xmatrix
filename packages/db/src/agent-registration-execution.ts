import { digestCanonicalCloneCborV1, parseSpaceAgentRegistrationKey, parseAgentRoutingRequirements,
  parseAgentRegistrationEnvironment, type SpaceAgentRegistrationKey, type AgentRoutingRequirements, hasControlCharacter,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { RegistrationAccessError } from "./agent-registration-errors.js";

interface Reservation {
  requestId: string; key: SpaceAgentRegistrationKey; runId: string; sourceCommandId: string;
  actorUserId: string; authorizationDigest: string; requirements: AgentRoutingRequirements;
}

function id(value: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 300 || hasControlCharacter(value)) {
    throw new RegistrationAccessError("invalid_allocation_identity", 400);
  }
  return value;
}

function view(row: QueryResultRow, reused: boolean) {
  return { allocationId: String(row.allocation_id), runId: String(row.run_id), generation: Number(row.generation),
    state: String(row.state), runtimeModel: row.runtime_model == null ? undefined : String(row.runtime_model), environmentVersion: Number(row.environment_version), reused };
}

async function machineLock(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey) {
  await tx.query({ name: "registration_allocation_machine_lock_v2", text: `SELECT pg_advisory_xact_lock(
    hashtextextended(jsonb_build_array('registration-machine-execution',$1::text,$2::text)::text,0))`,
    values: [key.ownerUserId,key.machineId], maxRows: 1 });
  const rows = await tx.query({ name: "registration_allocation_clock_v1", text: `SELECT clock_timestamp() AS authority_now`,
    values: [], maxRows: 1 });
  return rows[0]!;
}

/** A Machine its owner removed admits and continues no execution. */
async function requireMachineNotRetired(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey) {
  const retired = await tx.query({ name: "registration_allocation_machine_retired_v1", text: `SELECT 1
    FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2 AND retired_at IS NOT NULL FOR SHARE`,
  values: [key.ownerUserId, key.machineId], maxRows: 1 });
  if (retired[0]) throw new RegistrationAccessError("registration_machine_retired", 409);
}

async function physical(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey, requirements: AgentRoutingRequirements, now: number) {
  if (!Number.isFinite(now)) throw new RegistrationAccessError("registration_execution_clock_unavailable", 503);
  const rows = await tx.query({ name: "registration_allocation_environment_v1", text: `SELECT declaration_json,version
    FROM control.agent_registration_environments WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3 FOR SHARE`,
  values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("registration_environment_missing", 409);
  await requireMachineNotRetired(tx, key);
  const environment = parseAgentRegistrationEnvironment(rows[0].declaration_json);
  const through = requirements.availableThrough ? Date.parse(requirements.availableThrough) : now;
  // No requested model means the runtime default. A requested model must be one
  // the environment declares; an empty declaration allows no model override.
  if (!environment.enabled || (requirements.model && !environment.models.some(model =>
        model === requirements.model || environment.modelAliases?.[model] === requirements.model)) || through < now ||
      requirements.harness !== undefined && requirements.harness !== key.harness ||
      requirements.unattended && environment.availability !== "unattended" ||
      environment.availableUntil && Date.parse(environment.availableUntil) <= through ||
      requirements.requiredCapabilities.some(capability => !environment.capabilities.some(item =>
        item.key === capability && Date.parse(item.expiresAt) > through))) {
    throw new RegistrationAccessError("registration_environment_ineligible", 409);
  }
  return { environment, version: Number(rows[0].version) };
}

/** Stop evidence is the existing authenticated machine-route authority. Silence,
 * lease expiry, disconnect and an offline machine are never stop confirmation. */
async function collectTerminal(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey) {
  await tx.query({ name: "registration_allocation_terminal_collect_v1", text: `WITH finished AS (
      SELECT a.allocation_id FROM control.registration_execution_allocations a JOIN data.machine_run_routes r
        ON r.run_id=a.run_id AND r.owner_user_id=a.owner_user_id AND r.machine_id=a.machine_id
      WHERE a.owner_user_id=$1 AND a.machine_id=$2 AND a.state<>'released' AND r.terminal_at IS NOT NULL
      ORDER BY a.created_at LIMIT 64 FOR UPDATE OF a
    ) UPDATE control.registration_execution_allocations a SET state='released',released_at=clock_timestamp(),
      release_reason='process_terminal' FROM finished WHERE a.allocation_id=finished.allocation_id`,
  values: [key.ownerUserId, key.machineId], maxRows: 0 });
}

/** Internal resource authority. Its caller must obtain current Space/Channel
 * admission and bind the returned allocation to the durable Run before dispatch.
 * An allocation is not a task, credential or Space permission grant. No public
 * endpoint accepts caller-authored reservation evidence. */
export class PostgresRegistrationExecutionRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new RegistrationAccessError("cached_authority_forbidden", 500);
  }

  async reserve(raw: Reservation) {
    const key = parseSpaceAgentRegistrationKey(raw.key), requirements = parseAgentRoutingRequirements(raw.requirements);
    const input = { key, requirements, runId: id(raw.runId), sourceCommandId: id(raw.sourceCommandId), actorUserId: id(raw.actorUserId),
      authorizationDigest: raw.authorizationDigest };
    if (!/^[a-f0-9]{64}$/u.test(input.authorizationDigest)) throw new RegistrationAccessError("invalid_allocation_evidence", 400);
    const digest = await digestCanonicalCloneCborV1(input);
    return this.database.transaction({ requestId: raw.requestId, operation: "registration.execution.reserve" }, async tx => {
      await tx.query({ name: "registration_allocation_run_lock_v1", text: `SELECT pg_advisory_xact_lock(
        hashtextextended('registration-capacity-run:'||$1,0))`, values: [input.runId], maxRows: 1 });
      const cancelled = await tx.query({ name: "registration_allocation_preparation_fence_v1", text: `SELECT 1
        FROM control.registration_preparation_cancellations WHERE run_id=$1`, values: [input.runId], maxRows: 1 });
      if (cancelled[0]) throw new RegistrationAccessError("registration_preparation_aborted", 409);
      const machine = await machineLock(tx, key);
      await collectTerminal(tx, key);
      const previous = await tx.query({ name: "registration_allocation_replay_v1", text: `SELECT *
        FROM control.registration_execution_allocations WHERE run_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
      values: [input.runId], maxRows: 1 });
      const prior = previous[0];
      if (prior && (prior.space_id !== key.spaceId || prior.owner_user_id !== key.ownerUserId ||
          prior.machine_id !== key.machineId || prior.harness !== key.harness || prior.source_command_id !== input.sourceCommandId ||
          prior.actor_user_id !== input.actorUserId)) throw new RegistrationAccessError("allocation_binding_conflict", 409);
      if (prior && JSON.stringify(parseAgentRoutingRequirements(prior.requirements_json)) !== JSON.stringify(requirements)) {
        throw new RegistrationAccessError("idempotency_mismatch", 409);
      }
      if (prior && prior.state !== "released") {
        if (prior.request_digest !== digest) throw new RegistrationAccessError("idempotency_mismatch", 409);
        return view(prior, true);
      }
      if (prior && prior.release_reason !== "preparation_aborted") throw new RegistrationAccessError("allocation_terminal", 409);
      const current = await physical(tx, key, requirements, new Date(machine.authority_now as string).getTime());
      const generation = Number(prior?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new RegistrationAccessError("allocation_generation_exhausted", 409);
      const allocationId = `allocation:${crypto.randomUUID()}`;
      const aliases = current.environment.modelAliases;
      const runtimeModel = !requirements.model ? null : aliases && Object.hasOwn(aliases, requirements.model)
        ? aliases[requirements.model]! : requirements.model;
      const rows = await tx.query({ name: "registration_allocation_reserve_v1", text: `INSERT INTO control.registration_execution_allocations
        (allocation_id,run_id,generation,source_command_id,actor_user_id,space_id,owner_user_id,machine_id,harness,
         authorization_digest,requirements_json,request_digest,environment_version,runtime_model,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,'reserved') RETURNING *`,
      values: [allocationId, input.runId, generation, input.sourceCommandId, input.actorUserId, key.spaceId, key.ownerUserId,
        key.machineId, key.harness, input.authorizationDigest, JSON.stringify(requirements), digest, current.version, runtimeModel], maxRows: 1 });
      return view(rows[0]!, false);
    });
  }

  /** Called only after the owning shard has durably aborted preparation and
   * proved the Run absent. Fence late reservations under the same Run lock. */
  async abortPreparation(input: { requestId: string; key: SpaceAgentRegistrationKey; runId: string;
    sourceCommandId: string; actorUserId: string }): Promise<void> {
    const key = parseSpaceAgentRegistrationKey(input.key);
    await this.database.transaction({ requestId: input.requestId, operation: "registration.execution.abort-preparation" }, async tx => {
      await tx.query({ name: "registration_allocation_abort_lock_v1", text: `SELECT pg_advisory_xact_lock(
        hashtextextended('registration-capacity-run:'||$1,0))`, values: [id(input.runId)], maxRows: 1 });
      const prior = await tx.query({ name: "registration_allocation_abort_prior_v1", text: `SELECT *
        FROM control.registration_execution_allocations WHERE run_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
      values: [input.runId], maxRows: 1 });
      const row = prior[0];
      if (row && (row.space_id !== key.spaceId || row.owner_user_id !== key.ownerUserId || row.machine_id !== key.machineId ||
        row.harness !== key.harness || row.source_command_id !== input.sourceCommandId || row.actor_user_id !== input.actorUserId)) {
        throw new RegistrationAccessError("allocation_binding_conflict", 409);
      }
      if (row && !["reserved", "released"].includes(String(row.state))) throw new RegistrationAccessError("allocation_already_admitted", 409);
      const fence = await tx.query({ name: "registration_allocation_abort_fence_v1", text: `INSERT INTO control.registration_preparation_cancellations
        (run_id,space_id,owner_user_id,machine_id,harness,source_command_id,actor_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (run_id) DO UPDATE SET run_id=EXCLUDED.run_id
          WHERE registration_preparation_cancellations.space_id=EXCLUDED.space_id
            AND registration_preparation_cancellations.owner_user_id=EXCLUDED.owner_user_id
            AND registration_preparation_cancellations.machine_id=EXCLUDED.machine_id
            AND registration_preparation_cancellations.harness=EXCLUDED.harness
            AND registration_preparation_cancellations.source_command_id=EXCLUDED.source_command_id
            AND registration_preparation_cancellations.actor_user_id=EXCLUDED.actor_user_id RETURNING run_id`,
      values: [input.runId,key.spaceId,key.ownerUserId,key.machineId,key.harness,id(input.sourceCommandId),id(input.actorUserId)], maxRows: 1 });
      if (!fence[0]) throw new RegistrationAccessError("allocation_binding_conflict", 409);
      if (row?.state === "reserved") await tx.query({ name: "registration_allocation_abort_release_v1", text: `UPDATE control.registration_execution_allocations
        SET state='released',release_reason='preparation_aborted',released_at=clock_timestamp() WHERE allocation_id=$1`,
      values: [row.allocation_id], maxRows: 0 });
    });
  }

  /** The caller has just rechecked the owning Space's grant and startup fence.
   * Daemon identity comes from machine authentication, not its request body. */
  async admit(input: { requestId: string; allocationId: string; key: SpaceAgentRegistrationKey;
    runId: string; authorizationDigest: string; daemonId: string; hostId: string; connectionEpoch: number; expectedEnvironmentVersion?: number; expectedRuntimeModel?: string | null;
    expectedWorkspace?: { reference: string; canonicalCwd: string } }) {
    const key = parseSpaceAgentRegistrationKey(input.key);
    if (!Number.isSafeInteger(input.connectionEpoch) || input.connectionEpoch < 1) throw new RegistrationAccessError("invalid_daemon_epoch", 400);
    return this.database.transaction({ requestId: input.requestId, operation: "registration.execution.admit" }, async tx => {
      const machine = await machineLock(tx, key);
      await collectTerminal(tx, key);
      const daemons = await tx.query({ name: "registration_allocation_daemon_v2", text: `SELECT connection_epoch,status
        FROM data.machine_daemons WHERE daemon_id=$1 AND owner_user_id=$2 AND machine_id=$3 FOR SHARE`,
      values: [id(input.daemonId), key.ownerUserId, key.machineId], maxRows: 1 });
      if (!daemons[0] || daemons[0].status !== "online" || Number(daemons[0].connection_epoch) !== input.connectionEpoch) {
        // The daemon reconnected (or is between connections) after it was
        // offered this spawn. Nothing was admitted, so the launch can be
        // offered again to its current connection.
        throw new RegistrationAccessError("allocation_daemon_reconnected", 409);
      }
      if (input.expectedWorkspace) {
        const workspace = await tx.query({ name: "registration_allocation_workspace_v2", text: `SELECT 1 FROM data.workspaces
          WHERE workspace_id=$1 AND owner_user_id=$2 AND machine_id=$3 AND canonical_cwd=$4 FOR SHARE`,
        values: [id(input.expectedWorkspace.reference), key.ownerUserId, key.machineId, input.expectedWorkspace.canonicalCwd], maxRows: 1 });
        if (!workspace[0]) throw new RegistrationAccessError("allocation_workspace_changed", 403);
      }
      const row = await allocation(tx, key, input.allocationId, input.runId);
      if (input.expectedEnvironmentVersion !== undefined &&
          (!Number.isSafeInteger(input.expectedEnvironmentVersion) || input.expectedEnvironmentVersion < 1 ||
            Number(row.environment_version) !== input.expectedEnvironmentVersion)) {
        throw new RegistrationAccessError("allocation_environment_mismatch", 403);
      }

      if (input.expectedRuntimeModel !== undefined && row.runtime_model !== input.expectedRuntimeModel) {
        throw new RegistrationAccessError("allocation_model_mismatch", 403);
      }
      if (row.process_terminal === true) throw new RegistrationAccessError("allocation_terminal", 409);
      if (row.authorization_digest !== input.authorizationDigest) throw new RegistrationAccessError("allocation_authorization_changed", 403);
      if (row.state === "admitted") {
        if (row.daemon_id !== input.daemonId || Number(row.connection_epoch) !== input.connectionEpoch) {
          throw new RegistrationAccessError("allocation_daemon_changed", 409);
        }
        return view(row, true);
      }
      if (row.state !== "reserved") throw new RegistrationAccessError("allocation_terminal", 409);
      const current = await physical(tx, key, parseAgentRoutingRequirements(row.requirements_json), new Date(machine.authority_now as string).getTime());
      if (current.version !== Number(row.environment_version)) throw new RegistrationAccessError("allocation_environment_changed", 409);
      await tx.query({ name: "registration_allocation_admit_v1", text: `UPDATE control.registration_execution_allocations
        SET state='admitted',daemon_id=$2,connection_epoch=$3,admitted_at=clock_timestamp() WHERE allocation_id=$1`,
      values: [input.allocationId, input.daemonId, input.connectionEpoch], maxRows: 0 });
      return { ...view(row, false), state: "admitted" };
    });
  }

  /** A reconnect/credential refresh preserves its already admitted allocation.
   * New daemon connection epochs do not create new capacity or start a process.
   * Cancellation still fences renewal immediately, even before physical exit. */
  async requireContinuation(input: { requestId: string; key: SpaceAgentRegistrationKey; runId: string;
    allocationId: string; authorizationDigest: string; hostId: string }) {
    const key = parseSpaceAgentRegistrationKey(input.key);
    return this.database.transaction({ requestId: input.requestId, operation: "registration.execution.continue" }, async tx => {
      await machineLock(tx, key);
      await collectTerminal(tx, key);
      const row = await allocation(tx, key, input.allocationId, input.runId);
      if (row.process_terminal === true || row.state !== "admitted" || row.authorization_digest !== input.authorizationDigest) {
        throw new RegistrationAccessError("allocation_not_admitted", 403);
      }
      const daemons = await tx.query({ name: "registration_allocation_continuation_host_v2", text: `SELECT daemon_id
        FROM data.machine_daemons WHERE daemon_id=$1 AND owner_user_id=$2 AND machine_id=$3 FOR SHARE`,
      values: [row.daemon_id, key.ownerUserId, key.machineId], maxRows: 1 });
      if (!daemons[0]) throw new RegistrationAccessError("allocation_daemon_changed", 409);
      // An owner who turns the agent off on this machine withdraws running work too.
      const environment = await tx.query({ name: "registration_allocation_continuation_environment_v1", text: `SELECT 1
        FROM control.agent_registration_environments WHERE owner_user_id=$1 AND machine_id=$2 AND harness=$3
          AND declaration_json->'enabled'='true'::jsonb FOR SHARE`,
      values: [key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
      if (!environment[0]) throw new RegistrationAccessError("registration_environment_disabled", 403);
      await requireMachineNotRetired(tx, key);
      return view(row, true);
    });
  }

  /** Only an unstarted allocation can be released without physical stop proof.
   * preparation_aborted requires the coordinator to prove its Space transaction
   * finished without committing the Run. It permits a fresh generation, never
   * reuse of this allocation's admission nonce. */
  async cancel(input: { requestId: string; allocationId: string; key: SpaceAgentRegistrationKey;
    runId: string; reason: "preparation_aborted" | "cancelled_before_start" }) {
    const key = parseSpaceAgentRegistrationKey(input.key);
    if (!["preparation_aborted", "cancelled_before_start"].includes(input.reason)) throw new RegistrationAccessError("invalid_allocation_release", 400);
    return this.database.transaction({ requestId: input.requestId, operation: "registration.execution.cancel" }, async tx => {
      await machineLock(tx, key);
      const row = await allocation(tx, key, input.allocationId, input.runId);
      if (row.state === "released") return { state: "released", reused: true };
      if (row.process_terminal === true) {
        await tx.query({ name: "registration_allocation_cancel_terminal_v1", text: `UPDATE control.registration_execution_allocations
          SET state='released',release_reason='process_terminal',released_at=clock_timestamp() WHERE allocation_id=$1`,
        values: [input.allocationId], maxRows: 0 });
        return { state: "released", reused: false };
      }
      if (row.state !== "reserved") {
        if (input.reason === "preparation_aborted") throw new RegistrationAccessError("allocation_already_admitted", 409);
        await tx.query({ name: "registration_allocation_stop_pending_v1", text: `UPDATE control.registration_execution_allocations
          SET state='stopping' WHERE allocation_id=$1`, values: [input.allocationId], maxRows: 0 });
        return { state: "stopping", reused: row.state === "stopping" };
      }
      await tx.query({ name: "registration_allocation_cancel_unstarted_v1", text: `UPDATE control.registration_execution_allocations
        SET state='released',release_reason=$2,released_at=clock_timestamp() WHERE allocation_id=$1`,
      values: [input.allocationId, input.reason], maxRows: 0 });
      return { state: "released", reused: false };
    });
  }
}

async function allocation(tx: DatabaseTransaction, key: SpaceAgentRegistrationKey, allocationId: string, runId: string) {
  const rows = await tx.query({ name: "registration_allocation_exact_v2", text: `SELECT a.*,
    EXISTS (SELECT 1 FROM data.machine_run_routes r WHERE r.run_id=a.run_id AND r.owner_user_id=a.owner_user_id
      AND r.machine_id=a.machine_id AND r.terminal_at IS NOT NULL) AS process_terminal
    FROM control.registration_execution_allocations a
    WHERE a.allocation_id=$1 AND a.run_id=$2 AND a.space_id=$3 AND a.owner_user_id=$4 AND a.machine_id=$5 AND a.harness=$6 FOR UPDATE OF a`,
  values: [id(allocationId), id(runId), key.spaceId, key.ownerUserId, key.machineId, key.harness], maxRows: 1 });
  if (!rows[0]) throw new RegistrationAccessError("allocation_not_found", 404);
  return rows[0];
}

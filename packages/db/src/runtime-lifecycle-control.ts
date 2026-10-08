import { cleanRepositoryBaseline, type RepositoryBaseline } from "@xmatrix/protocol";
import { storeScopedCommandReplay } from "./command-replay.js";
import { hostnameMetadata } from "./hostname-metadata.js";
import { acknowledgeMachineExecution, recordMessageExecutions } from "./runtime-message-executions.js";
import type { QueryResultRow } from "pg";
import {
  automationRunIdentity,
  publicMachineStartupFailure,
  isTerminalRunStatus,
  machineExecutionCompleted,
  scheduledMachineExecutionCompleted,
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUS_SQL } from "@xmatrix/protocol";
import { commandDigest as digest } from "./command-digest.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { PostgresEntitySpaceDirectory } from "./entity-directory.js";
import {
  PostgresChannelSpaceDirectory,
  PostgresSpacePlacementDirectory,
  type SpacePlacement,
} from "./placement.js";
import { invocationProgress, readInvocationProgress } from "./runtime-invocation-progress.js";
import { commitRuntime, RuntimeControlError } from "./runtime-control.js";
import { resumableChannelRun, runEndRestState, type InstanceRestState } from "./instance-rest-state.js";
import { commandFields } from "./command-fields.js";

/** A Run's name is its Space registration's display name. */
const registrationNameJoinSql = (spaceParam: string) => `LEFT JOIN data.run_agent_registrations binding
        ON binding.run_id=r.run_id AND binding.space_id=${spaceParam}
      LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
        AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
        AND registration.harness=binding.harness`;
const REGISTRATION_AGENT_NAME_SQL = "COALESCE(registration.display_name,r.metadata_json->>'agentName')";

const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LEGACY_SNAPSHOT_SETTLE_MS = 60_000;

interface RegistryCausalEvidence {
  connectionEpoch: number;
  sequence: number;
  capturedAt?: string;
}

const { text, object: record } = commandFields((field) =>
  new RuntimeControlError("invalid_machine_lifecycle", 400, `${field} is invalid`));

function metadata(row: QueryResultRow): Record<string, unknown> {
  return row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown> : {};
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RuntimeControlError(
    "invalid_machine_lifecycle", 400, `${field} is invalid`);
  return Number(value);
}

function registryCausalEvidence(payload: Record<string, unknown>, connectionEpoch: number | undefined,
  snapshot: boolean): RegistryCausalEvidence | undefined {
  const fields = [payload.registryConnectionEpoch, payload.registrySequence,
    ...(snapshot ? [payload.capturedAt] : [])];
  if (fields.every((value) => value === undefined)) return undefined;
  if (fields.some((value) => value === undefined)) throw new RuntimeControlError(
    "invalid_machine_lifecycle", 400, "Machine registry causal evidence is incomplete");
  const epoch = positiveInteger(payload.registryConnectionEpoch, "payload.registryConnectionEpoch");
  const sequence = positiveInteger(payload.registrySequence, "payload.registrySequence");
  if (connectionEpoch === undefined || snapshot && epoch !== connectionEpoch ||
      !snapshot && epoch > connectionEpoch) throw new RuntimeControlError(
    "conflict", 409, "Machine registry causal evidence does not match the active connection");
  if (!snapshot) return { connectionEpoch: epoch, sequence };
  const capturedAt = text(payload.capturedAt, "payload.capturedAt", 80);
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) throw new RuntimeControlError(
    "invalid_machine_lifecycle", 400, "payload.capturedAt is invalid");
  return { connectionEpoch: epoch, sequence, capturedAt: new Date(capturedMs).toISOString() };
}

function snapshotMayRetireRun(body: Record<string, unknown>, updatedAt: unknown,
  causal: RegistryCausalEvidence, receivedAt: string): boolean {
  const binding = body.daemonRegistry;
  if (binding && typeof binding === "object" && !Array.isArray(binding)) {
    const value = binding as Record<string, unknown>;
    const epoch = Number(value.connectionEpoch);
    const sequence = Number(value.sequence);
    if (Number.isSafeInteger(epoch) && epoch >= 1 && Number.isSafeInteger(sequence) && sequence >= 1) {
      return epoch < causal.connectionEpoch || epoch === causal.connectionEpoch && sequence < causal.sequence;
    }
  }
  // Settle against the moment the daemon captured its registry, not the moment
  // this authority happened to apply the report: Hub-side queueing can delay a
  // snapshot for minutes, and receive time would then retire Runs that started
  // after the capture. A host clock running ahead never earns a wider window
  // than its arrival already proves.
  const receivedMs = Date.parse(receivedAt);
  const capturedMs = causal.capturedAt ? Date.parse(causal.capturedAt) : Number.NaN;
  const settleAt = Number.isFinite(capturedMs) ? Math.min(capturedMs, receivedMs) : receivedMs;
  const updatedMs = Date.parse(String(updatedAt));
  return Number.isFinite(updatedMs) && updatedMs <= settleAt - LEGACY_SNAPSHOT_SETTLE_MS;
}

async function replay(tx: DatabaseTransaction, spaceId: string, commandId: string,
  requestDigest: string): Promise<Record<string, unknown> | null> {
  const rows = await tx.query<QueryResultRow>({ name: "machine_lifecycle_replay_read_v1", text: `SELECT
    request_digest,result_json FROM control.scoped_control_command_replays WHERE scope_kind='space'
    AND scope_id=$1 AND command_id=$2 AND command_kind='machine_run_lifecycle'
    AND expires_at>clock_timestamp() LIMIT 1`, values: [spaceId, commandId], maxRows: 1 });
  if (!rows[0]) return null;
  if (rows[0].request_digest !== requestDigest) throw new RuntimeControlError(
    "idempotency_mismatch", 409, "Machine lifecycle command id was reused");
  return { ...(rows[0].result_json as Record<string, unknown>), reused: true };
}

async function commit(tx: DatabaseTransaction, input: { spaceId: string; commandId: string;
  requestDigest: string; value: Record<string, unknown>; at: string }) {
  await commitRuntime(tx, input.spaceId, input.value, input.at,
    { head: "machine_lifecycle_head_advance_v1", outbox: "machine_lifecycle_outbox_v1" });
  await storeScopedCommandReplay(tx, "machine_lifecycle_replay_write_v1", {
    scopeKind: "space", scopeId: input.spaceId, commandId: input.commandId,
    commandKind: "machine_run_lifecycle", requestDigest: input.requestDigest, result: input.value, at: input.at, ttlMs: REPLAY_TTL_MS,
  });
}

function failureDetail(payload: Record<string, unknown>): string {
  for (const field of ["runStatusDetail", "error", "status", "statusPhase"] as const) {
    const failure = publicMachineStartupFailure(payload[field]);
    if (failure) return failure.summary;
  }
  return "Machine Daemon did not complete the Agent Run successfully";
}

async function channelAboutFollowUp(tx: DatabaseTransaction, runId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "machine_lifecycle_about_run_v1", text: `SELECT
    run_id,channel_id,status,metadata_json FROM data.runs WHERE run_id=$1 LIMIT 1`,
  values: [runId], maxRows: 1 });
  const run = rows[0];
  if (!run || !isTerminalRunStatus(run.status)) return undefined;
  const latestRows = await tx.query<QueryResultRow>({ name: "machine_lifecycle_about_latest_v1", text: `SELECT
    run_id,status,metadata_json FROM data.runs WHERE channel_id=$1
    AND metadata_json->>'routedAs'='management_channel_about'
    ORDER BY created_at DESC,run_id DESC LIMIT 1`, values: [run.channel_id], maxRows: 1 });
  const latest = latestRows[0];
  if (!latest || latest.run_id !== runId || !isTerminalRunStatus(latest.status)) return undefined;
  const body = metadata(latest);
  const trigger = typeof body.channelAboutTriggerRequestId === "string"
    ? body.channelAboutTriggerRequestId.trim() : typeof body.sourceMessageId === "string"
      ? body.sourceMessageId.trim() : "";
  const pending = typeof body.channelAboutPendingRequestId === "string"
    ? body.channelAboutPendingRequestId.trim() : trigger;
  const actor = typeof body.channelAboutPendingActorUserId === "string"
    ? body.channelAboutPendingActorUserId.trim() : typeof body.summonedByUserId === "string"
      ? body.summonedByUserId.trim() : "";
  const spaceId = typeof body.managementSpaceId === "string" ? body.managementSpaceId.trim() : "";
  if (!trigger || !pending || pending === trigger || !actor || !spaceId) return undefined;
  const duplicate = await tx.query({ name: "machine_lifecycle_about_successor_v1", text: `SELECT 1
    FROM data.runs WHERE channel_id=$1 AND run_id<>$2
      AND metadata_json->>'routedAs'='management_channel_about'
      AND metadata_json->>'channelAboutTriggerRequestId'=$3 LIMIT 1`,
  values: [run.channel_id, runId, pending], maxRows: 1 });
  return duplicate[0] ? undefined : { spaceId, channelId: String(run.channel_id), requestId: pending,
    successorOfRunId: runId, actorUserId: actor,
    ...(typeof body.channelAboutPendingMessageId === "string" ? { triggerMessageId: body.channelAboutPendingMessageId } : {}) };
}

export interface MachineLifecycleInput {
  commandId: string;
  ownerUserId: string;
  machineId: string;
  hostId: string;
  connectionEpoch?: number;
  channelId: string;
  principal: Record<string, unknown>;
  eventType: string;
  payload: Record<string, unknown>;
  recoverableLaunchFailure?: boolean;
  repoPool?: Record<string, string>;
  repositoryBaseline?: RepositoryBaseline;
  preserveInstanceForReborn?: boolean;
}

export class PostgresMachineLifecycleRepository {
  private readonly channelDirectory: PostgresChannelSpaceDirectory;
  private readonly entityDirectory: PostgresEntitySpaceDirectory;
  private readonly placements: PostgresSpacePlacementDirectory;

  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new RuntimeControlError(
      "cached_authority_forbidden", 500, "Machine lifecycle authority requires uncached PostgreSQL");
    this.channelDirectory = new PostgresChannelSpaceDirectory(database);
    this.entityDirectory = new PostgresEntitySpaceDirectory(database);
    this.placements = new PostgresSpacePlacementDirectory(database);
  }

  private async placement(commandId: string, channelId: string): Promise<SpacePlacement> {
    const route = await this.channelDirectory.resolve(
      { requestId: commandId, operation: "machine-lifecycle.channel.locate" }, channelId,
    );
    let spaceId = route?.spaceId ?? null;
    if (!spaceId) {
      const rows = await this.database.transaction(
        { requestId: commandId, operation: "machine-lifecycle.channel.locate-legacy" },
        (tx) => tx.query<QueryResultRow>({ name: "machine_lifecycle_channel_space_legacy_v2",
          text: "SELECT space_id FROM data.channels WHERE channel_id=$1 LIMIT 1",
          values: [channelId], maxRows: 1 }),
      );
      spaceId = rows[0] ? String(rows[0].space_id) : null;
    }
    if (!spaceId) throw new RuntimeControlError("not_found", 404, "Lifecycle Channel not found");
    return this.placements.resolveWritable(
      { requestId: commandId, operation: "machine-lifecycle.placement" }, spaceId, () => new RuntimeControlError(
        "space_placement_unavailable", 503, "Space placement is unavailable", true));
  }

  private async publishRuntimeRoutes(
    commandId: string, placement: SpacePlacement, runIds: readonly string[],
  ): Promise<void> {
    if (runIds.length === 0) return;
    const rows = await this.database.transaction({
      requestId: commandId, operation: "machine-lifecycle.directory-source",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch },
    }, (tx) => tx.query<QueryResultRow>({ name: "machine_lifecycle_route_source_v1", text: `SELECT
        run.run_id,run.version AS run_version,instance.instance_id,
        instance.version AS instance_version,head.commit_sequence AS route_version,head.updated_at
      FROM data.runs run JOIN data.channels channel ON channel.channel_id=run.channel_id
      JOIN data.space_control_heads head ON head.space_id=channel.space_id
      LEFT JOIN data.instances instance ON instance.run_id=run.run_id
      WHERE channel.space_id=$1 AND run.run_id=ANY($2::text[])`,
    values: [placement.spaceId, runIds], maxRows: Math.max(1, runIds.length * 2) }));
    const publishedRuns = new Set<string>();
    for (const row of rows) {
      const runId = String(row.run_id);
      if (!publishedRuns.has(runId)) {
        await this.entityDirectory.publish({ requestId: commandId,
          operation: "machine-lifecycle.run.directory-publish" }, {
          kind: "run", entityId: runId, spaceId: placement.spaceId, shardId: placement.shardId,
          placementEpoch: placement.placementEpoch, entityVersion: Number(row.run_version),
          routeVersion: Number(row.route_version), state: "active", updatedAt: String(row.updated_at),
        });
        publishedRuns.add(runId);
      }
      if (row.instance_id) await this.entityDirectory.publish({ requestId: commandId,
        operation: "machine-lifecycle.instance.directory-publish" }, {
        kind: "instance", entityId: String(row.instance_id), spaceId: placement.spaceId,
        shardId: placement.shardId, placementEpoch: placement.placementEpoch,
        entityVersion: Number(row.instance_version), routeVersion: Number(row.route_version),
        state: "active", updatedAt: String(row.updated_at),
      });
    }
  }

  async apply(input: MachineLifecycleInput): Promise<Record<string, unknown>> {
    const commandId = text(input.commandId, "commandId", 200);
    const ownerUserId = text(input.ownerUserId, "ownerUserId", 200);
    const machineId = text(input.machineId, "machineId", 160);
    const hostId = input.hostId === undefined || input.hostId === "" ? "" : text(input.hostId, "hostId", 160);
    const channelId = text(input.channelId, "channelId", 300);
    const principal = record(input.principal, "principal");
    if (principal.kind !== "machine" || principal.ownerUserId !== ownerUserId ||
        principal.machineId !== machineId) throw new RuntimeControlError(
      "forbidden", 403, "Machine lifecycle requires the exact authenticated Machine principal");
    const eventType = text(input.eventType, "eventType", 80);
    if (!["machine_spawn_result", "machine_run_exited", "machine_stop_result",
      "machine_run_snapshot", "machine_execution_report"].includes(eventType)) throw new RuntimeControlError(
      "invalid_machine_lifecycle", 400, "Machine lifecycle event is invalid");
    const payload = record(input.payload, "payload");
    const connectionEpoch = input.connectionEpoch === undefined
      ? undefined : positiveInteger(input.connectionEpoch, "connectionEpoch");
    const registryCausal = eventType === "machine_run_snapshot"
      ? registryCausalEvidence(payload, connectionEpoch, true)
      : eventType === "machine_spawn_result" && payload.ok === true
        ? registryCausalEvidence(payload, connectionEpoch, false) : undefined;
    const at = new Date().toISOString();
    const requestDigest = await digest(input);
    const placement = await this.placement(commandId, channelId);
    if (eventType === "machine_execution_report") return this.database.transaction({ requestId: commandId,
      operation: "runtime.execution-report", placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } }, tx => acknowledgeMachineExecution(tx, {
      spaceId: placement.spaceId, channelId, ownerUserId, machineId, hostId, payload, at,
    }));
    const value = await this.database.transaction({ requestId: commandId,
      operation: `runtime.machine-lifecycle.${eventType}`,
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } }, async (tx) => {
      await tx.query({ name: "machine_lifecycle_channel_lock_v1",
        text: "SELECT pg_advisory_xact_lock(hashtextextended('machine-lifecycle:'||$1,0))",
        values: [channelId], maxRows: 1 });
      // Authenticated Machine reports terminalize or reconcile an existing Run.
      // Archiving freezes new work but must not strand that Run's final evidence.
      const channels = await tx.query<QueryResultRow>({ name: "machine_lifecycle_channel_v2", text: `SELECT
        channel_id,space_id FROM data.channels WHERE channel_id=$1 LIMIT 1`,
      values: [channelId], maxRows: 1 });
      const channel = channels[0];
      if (!channel) throw new RuntimeControlError("not_found", 404, "Lifecycle Channel not found");
      if (String(channel.space_id) !== placement.spaceId) throw new RuntimeControlError(
        "conflict", 409, "Lifecycle Channel Space placement changed");
      const prior = await replay(tx, String(channel.space_id), commandId, requestDigest);
      if (prior) return prior;
      const changedRunIds = eventType === "machine_run_snapshot"
        ? await this.reconcileSnapshot(tx, { ownerUserId, machineId, hostId, channelId, payload, at,
          spaceId: placement.spaceId, registryCausal })
        : [await this.applyEvent(tx, { ...input, ownerUserId, machineId, hostId, channelId,
          connectionEpoch, eventType, payload, at, spaceId: placement.spaceId, registryCausal })]
          .filter((value): value is string => Boolean(value));
      const followUps = [];
      for (const runId of changedRunIds) {
        const followUp = await channelAboutFollowUp(tx, runId);
        if (followUp) followUps.push(followUp);
      }
      const value = { commandId, kind: "machine_run_lifecycle", reused: false,
        entityId: changedRunIds[0] ?? channelId, entityVersion: 1,
        changedRunIds, ...(followUps.length ? { channelAboutFollowUps: followUps } : {}) };
      // A failed stop changes no Run, yet the Channel must hear the process may
      // still run; the notice's stable ids keep a replayed result from repeating it.
      const stopNotice = eventType === "machine_stop_result" && input.preserveInstanceForReborn !== true;
      // Launch update may already have terminalized this Run before the exact
      // Machine report arrives. Its failure notice is still owed even when
      // applying that authenticated report makes no further status transition.
      const spawnFailure = eventType === "machine_spawn_result" && payload.ok !== true &&
        input.recoverableLaunchFailure !== true;
      const baselineNotice = eventType === "machine_spawn_result" && payload.ok === true &&
        input.repositoryBaseline?.relationship === "diverged" && input.repositoryBaseline.noticeKey !== undefined;
      if ((eventType === "machine_run_exited" || spawnFailure || stopNotice || baselineNotice) &&
          typeof payload.runId === "string" && (spawnFailure || stopNotice || changedRunIds.includes(payload.runId))) {
        const contexts = await tx.query<QueryResultRow>({ name: "machine_lifecycle_notice_context_v5", text: `SELECT
          r.run_id,r.channel_id,r.owner_user_id,r.status,r.metadata_json->>'routedAs' AS routed_as,r.metadata_json,
          (r.metadata_json->'spawnResult'->>'ok'='false' OR
            EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=r.run_id
              AND launch.state='failed' AND launch.spawned_at IS NULL)) AS startup_failed,
          registration.display_name AS agent_name,machine.name AS machine_name
          FROM data.runs r
          JOIN data.run_agent_registrations binding ON binding.run_id=r.run_id AND binding.space_id=$3
          JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
            AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
            AND registration.harness=binding.harness
          LEFT JOIN data.machines machine ON machine.owner_user_id=binding.owner_user_id
            AND machine.machine_id=binding.machine_id
          WHERE r.run_id=$1 AND r.channel_id=$2 AND r.owner_user_id=$4`,
          values: [payload.runId, channelId, placement.spaceId, ownerUserId], maxRows: 1 });
        const context = contexts[0];
        const notice = context && { runId: String(context.run_id), channelId: String(context.channel_id),
          ownerUserId: String(context.owner_user_id), agentName: String(context.agent_name), machineId, hostId,
          // The Channel names the Machine as its owner did; the hostname is only an observation.
          ...(context.machine_name ? { machineName: String(context.machine_name) } : {}) };
        if (!notice || context!.routed_as === "management_channel_about" ||
            spawnFailure && (context!.status !== "failed" ||
              metadata(context!).executionCancellation !== undefined)) { /* no Channel notice */ }
        // A stop's Channel feedback is the daemon's actual termination result;
        // a scheduled occurrence keeps its own ledger instead.
        else if (baselineNotice && cleanRepositoryBaseline(metadata(context!).repositoryBaseline)?.noticeKey === input.repositoryBaseline?.noticeKey) {
          Object.assign(value, { repositoryBaselineNoticeContext: { ...notice, baseline: input.repositoryBaseline } });
        }
        else if (stopNotice) {
          const runMetadata = metadata(context!);
          const stopRequest = runMetadata.stopRequest;
          const channelStop = Boolean(stopRequest && typeof stopRequest === "object" && !Array.isArray(stopRequest) &&
            typeof (stopRequest as { sourceMessageId?: unknown }).sourceMessageId === "string" &&
            (stopRequest as { sourceMessageId: string }).sourceMessageId);
          const startupFailed = context!.status === "failed" && context!.startup_failed === true &&
            runMetadata.executionCancellation === undefined;
          // A channel stop's confirmation is the chip on the command that
          // asked for it. Startup-failure cleanup still has to say why the
          // process never started, and a stop that did not come from a
          // channel command still posts, because nothing else would.
          if (automationRunIdentity(runMetadata).automationOccurrenceId === undefined &&
              !(payload.ok === true && channelStop && !startupFailed)) Object.assign(value, {
            stopResultNoticeContext: { ...notice, ok: payload.ok === true,
              ...(startupFailed ? { startupFailed: true } : {}),
              controlKey: typeof payload.requestId === "string" && payload.requestId ? payload.requestId.slice(0, 200) : notice.runId,
              ...(typeof payload.error === "string" && payload.error.trim() ? { detail: payload.error.trim().slice(0, 2_000) } : {}) },
          });
        } else Object.assign(value, { startupFailureNoticeContext: notice });
      }
      await commit(tx, { spaceId: String(channel.space_id), commandId, requestDigest, value, at });
      return value;
    });
    await this.publishRuntimeRoutes(commandId, placement,
      Array.isArray(value.changedRunIds) ? value.changedRunIds.map(String) : []);
    // Re-read committed state on replay too. Never close a resumed/reborn
    // Instance merely because an earlier report terminalized its predecessor.
    const terminalInstances = input.preserveInstanceForReborn === true ? [] : await this.database.transaction({
      requestId: commandId, operation: "machine-lifecycle.terminal-instances",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch },
    }, tx => tx.query<QueryResultRow>({ name: "machine_lifecycle_terminal_instances_v1", text: `SELECT i.instance_id
      FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
      WHERE r.run_id=ANY($1::text[]) AND r.channel_id=$2 AND i.status='offline'
        AND r.status=ANY($3::text[])`,
      values: [Array.isArray(value.changedRunIds) ? value.changedRunIds.map(String) : [], channelId,
        [...TERMINAL_RUN_STATUSES]], maxRows: 10_000 }));
    return { ...value, terminalInstanceIds: terminalInstances.map(row => String(row.instance_id)) };
  }

  private async applyEvent(tx: DatabaseTransaction, input: MachineLifecycleInput & { at: string; spaceId: string;
    registryCausal?: RegistryCausalEvidence }) {
    const runId = typeof input.payload.runId === "string" && input.payload.runId.trim()
      ? text(input.payload.runId, "payload.runId", 300) : undefined;
    if (!runId) return undefined;
    const rows = await tx.query<QueryResultRow>({ name: "machine_lifecycle_run_lock_v2", text: `SELECT
      r.*,i.instance_id,i.status AS instance_status,i.version AS instance_version,
      i.channel_instance_id,${REGISTRATION_AGENT_NAME_SQL} AS agent_name
      FROM data.runs r LEFT JOIN data.instances i ON i.run_id=r.run_id
      ${registrationNameJoinSql("$3")}
      WHERE r.run_id=$1 AND r.channel_id=$2 FOR UPDATE OF r`, values: [runId, input.channelId, input.spaceId], maxRows: 1 });
    const run = rows[0];
    if (!run || run.owner_user_id !== input.ownerUserId) throw new RuntimeControlError(
      "not_found", 404, "Machine lifecycle Run is not owned by this principal");
    const body = metadata(run);
    if (body.machineId !== input.machineId) throw new RuntimeControlError(
      "forbidden", 403, "Machine lifecycle Machine does not match the Run");
    if ((input.eventType === "machine_run_exited" || input.eventType === "machine_stop_result") &&
        (typeof input.payload.executionKey !== "string" ||
         input.payload.executionKey !== body.executionKey)) throw new RuntimeControlError(
      "conflict", 409, "Machine lifecycle execution key does not match the Run");
    const terminal = isTerminalRunStatus(run.status);
    let status: string | undefined;
    let finishedAt: string | null | undefined;
    if (input.eventType === "machine_spawn_result" && !terminal &&
        (input.payload.ok === true || input.recoverableLaunchFailure !== true)) {
      // A Run a stop fenced while it spawned stays `stopping`: a late spawn
      // success must not hand it back the authority the stop removed.
      status = input.payload.ok !== true ? "failed" : run.status === "stopping" ? undefined : "running";
      finishedAt = input.payload.ok === true ? undefined : input.at;
    } else if (input.eventType === "machine_run_exited" && !terminal) {
      status = automationRunIdentity(body).automationId
        ? scheduledMachineExecutionCompleted(input.payload) ? "completed" : "failed"
        : machineExecutionCompleted(input.payload) ? "completed" : "exited";
      finishedAt = input.at;
    } else if (input.eventType === "machine_stop_result" && input.payload.ok === true) {
      status = terminal ? String(run.status) : "stopped";
      finishedAt = run.finished_at ? new Date(run.finished_at as Date).toISOString() : input.at;
    }
    const deletion = body.instanceDeletion && typeof body.instanceDeletion === "object"
      ? body.instanceDeletion as Record<string, unknown> : undefined;
    const deletionPending = deletion?.state === "pending";
    const cancellation = body.executionCancellation && typeof body.executionCancellation === "object"
      ? body.executionCancellation as Record<string, unknown> : undefined;
    const cleanupConfirmed = cancellation && (input.eventType === "machine_run_exited" ||
      input.eventType === "machine_stop_result" && input.payload.ok === true);
    if (input.eventType === "machine_run_exited") await recordMessageExecutions(tx, {
      spaceId: input.spaceId, channelId: input.channelId, runId, instanceId: run.instance_id,
      agentName: run.agent_name,
      channelInstanceId: run.channel_instance_id, at: input.at,
    }, input.payload.taskExecution);
    const terminalProgress = input.eventType === "machine_run_exited"
      ? invocationProgress(input.payload, input.at) ?? { observedAt: input.at } : undefined;
    const previousProgress = readInvocationProgress(body.invocationProgress);
    const terminalEvidence = input.eventType === "machine_run_exited" ||
      input.eventType === "machine_stop_result" && input.payload.ok === true ? {
        schemaVersion: 1,
        kind: input.eventType === "machine_run_exited" ? "run_exited" : "stop_succeeded",
        runId, machineId: input.machineId, hostname: input.hostId || undefined,
        ...(input.eventType === "machine_stop_result" ? { controlId: input.payload.requestId } : {}),
        executionKey: input.payload.executionKey, completedAt: input.at,
      } : undefined;
    // Readers that waited for this spawn command to complete (owner delete)
    // wait for this marker too: command completion commits before it.
    const spawnResult = input.eventType === "machine_spawn_result" && typeof input.payload.requestId === "string"
      ? { controlId: input.payload.requestId, ok: input.payload.ok === true, at: input.at } : undefined;
    const nextBody = { ...body,
      ...(cleanupConfirmed ? { executionCancellation: { ...cancellation,
        processCleanup: { ...(cancellation.processCleanup as Record<string, unknown>),
          status: "confirmed", confirmedAt: input.at } } } : {}),
      ...(terminalProgress ? { invocationProgress: {
        ...(previousProgress.startupSteps ? { startupSteps: previousProgress.startupSteps } : {}),
        ...(previousProgress.wrapperReadyAt ? { wrapperReadyAt: previousProgress.wrapperReadyAt } : {}),
        ...terminalProgress,
      } } : {}), ...(input.repoPool ? { repoPool: input.repoPool } : {}),
      ...(cleanRepositoryBaseline(input.repositoryBaseline) ? { repositoryBaseline: cleanRepositoryBaseline(input.repositoryBaseline) } : {}),
      ...(spawnResult ? { spawnResult } : {}),
      ...(input.eventType === "machine_spawn_result" && input.payload.ok === true && input.registryCausal
        ? { daemonRegistry: { schemaVersion: 1,
          connectionEpoch: input.registryCausal.connectionEpoch,
          sequence: input.registryCausal.sequence } } : {}),
      ...(terminalEvidence ? { daemonTerminalEvidence: terminalEvidence,
        // A late natural-exit report must not erase the exact stop receipt.
        ...(input.eventType === "machine_stop_result" ? { daemonStopEvidence: terminalEvidence } : {}),
      } : {}),
      };
    if (status || input.repoPool || cleanupConfirmed || spawnResult) await tx.query({ name: "machine_lifecycle_run_update_v1", text: `UPDATE
      data.runs SET status=COALESCE($1,status),metadata_json=$2::jsonb,version=version+1,
      updated_at=$3,finished_at=COALESCE($4,finished_at) WHERE run_id=$5 AND owner_user_id=$6
      AND version=$7 RETURNING run_id`, values: [status ?? null, JSON.stringify(hostnameMetadata(nextBody)), input.at,
      finishedAt ?? null, runId, input.ownerUserId, run.version], maxRows: 1 });
    if (input.eventType === "machine_spawn_result" && !cancellation) {
      // A recoverable failure is offered again, to whichever daemon holds the
      // machine next, as a new spawn command: the failed one already completed.
      const retry = input.payload.ok !== true && input.recoverableLaunchFailure === true;
      // A background session (a Channel's About) has no Instance to connect:
      // its spawn is its start, so its Run ending later is no failed launch.
      const launchState = input.payload.ok === true ? run.instance_id ? "spawned" : "connected" : retry ? "queued" : "failed";
      const retried = await tx.query({ name: "machine_lifecycle_launch_update_v2", text: `WITH input AS (SELECT
        $1::text AS run_id,$2::text AS launch_state,$3::boolean AS succeeded,
        $4::text AS failure_detail,$5::boolean AS retryable,$6::timestamptz AS at)
        UPDATE data.agent_launches launch SET
        state=COALESCE(input.launch_state,launch.state),daemon_offline=FALSE,
        error_stage=CASE WHEN input.succeeded THEN NULL ELSE 'daemon_spawn' END,
        error_code=CASE WHEN input.succeeded THEN NULL ELSE 'machine_spawn_failed' END,
        error_message=CASE WHEN input.succeeded THEN NULL ELSE left(input.failure_detail,2000) END,
        retryable=input.retryable,
        next_attempt_at=CASE WHEN input.retryable THEN clock_timestamp()+interval '5 seconds'
          ELSE launch.next_attempt_at END,
        control_id=CASE WHEN input.retryable THEN 'control:'||gen_random_uuid()::text ELSE launch.control_id END,
        attempt=launch.attempt+CASE WHEN input.retryable THEN 1 ELSE 0 END,
        command_durable_at=CASE WHEN input.retryable THEN NULL ELSE launch.command_durable_at END,
        lease_owner=NULL,lease_until=NULL,version=launch.version+1,updated_at=input.at,
        connected_at=CASE WHEN input.launch_state='connected' THEN COALESCE(launch.connected_at,input.at) ELSE launch.connected_at END,
        finished_at=CASE WHEN input.launch_state IN ('failed','connected') THEN input.at ELSE NULL END
        FROM input WHERE launch.run_id=input.run_id
        AND launch.state NOT IN ('connected','cancelled') RETURNING launch.control_id`, values: [runId, launchState,
      input.payload.ok === true, failureDetail(input.payload), retry, input.at], maxRows: 1 });
      if (retry && retried[0]) await tx.query({ name: "machine_lifecycle_retry_spawn_control_v1", text: `UPDATE
        data.runs SET metadata_json=jsonb_set(metadata_json,'{spawnControlId}',to_jsonb($2::text)),
        version=version+1,updated_at=$3 WHERE run_id=$1`,
      values: [runId, String(retried[0].control_id), input.at], maxRows: 0 });
    }
    if (run.instance_id && !deletionPending && (input.eventType === "machine_run_exited" ||
        input.eventType === "machine_stop_result" && input.payload.ok === true) &&
        run.instance_status !== "offline") await tx.query({
      name: "machine_lifecycle_instance_offline_v1", text: `UPDATE data.instances SET
        status='offline',version=version+1,updated_at=$1 WHERE instance_id=$2 AND run_id=$3
        AND version=$4 RETURNING instance_id`, values: [input.at, run.instance_id, runId,
      run.instance_version], maxRows: 1 });
    const restChanged = run.instance_id && !deletionPending
      ? await this.recordRestState(tx, input, runId, body, String(run.status), String(run.instance_id), status)
      : false;
    // A stopped reborn predecessor makes its waiting successor due now, so the
    // coordinator wake that follows the stop does not wait out the retry delay.
    if (run.instance_id && input.preserveInstanceForReborn === true &&
        input.eventType === "machine_stop_result" && input.payload.ok === true) await tx.query({
      name: "machine_lifecycle_reborn_due_v1", text: `UPDATE data.agent_reborn_intents
        SET next_attempt_at=clock_timestamp() WHERE source_instance_id=$1 AND source_run_id=$2
        AND state='waiting' AND next_attempt_at>clock_timestamp()`,
      values: [run.instance_id, runId], maxRows: 0 });
    if (status && isTerminalRunStatus(status) && run.instance_id &&
        input.preserveInstanceForReborn !== true) await tx.query({
      name: "machine_lifecycle_trace_expire_v1", text: `UPDATE data.trace_access_grants SET
        status='expired',version=version+1,decided_at=COALESCE(decided_at,$2)
        WHERE instance_id=$1 AND status='approved' AND duration IN ('once','channel')`,
      values: [run.instance_id, input.at], maxRows: 0 });
    if (!cancellation) await this.updateSchedule(tx, runId, body, input.eventType, input.payload, status, input.at);
    return status || input.repoPool || cleanupConfirmed || restChanged ? runId : undefined;
  }

  /**
   * Why this Run's end leaves its Instance offline (docs/instance-sleep.md §1).
   * Only the report that ends the Run decides, with one exception: a sleep
   * report that arrives after a snapshot already retired the same Run as
   * interrupted refines it to sleeping. Nothing overwrites `stopped`, and a
   * reborn predecessor's stop leaves the state to its successor.
   */
  private async recordRestState(tx: DatabaseTransaction, input: MachineLifecycleInput & { at: string },
    runId: string, body: Record<string, unknown>, previousRunStatus: string, instanceId: string,
    nextRunStatus: string | undefined): Promise<boolean> {
    let rest: InstanceRestState | null = null;
    let refineOnly = false;
    if (input.eventType === "machine_run_exited" && nextRunStatus) {
      rest = runEndRestState({ metadata: body, previousRunStatus, nextRunStatus,
        restReason: input.payload.restReason });
    } else if (input.eventType === "machine_run_exited" && input.payload.restReason === "sleeping" &&
        previousRunStatus === "exited" && resumableChannelRun(body)) {
      rest = "sleeping";
      refineOnly = true;
    } else if (input.eventType === "machine_stop_result" && input.payload.ok === true &&
        input.preserveInstanceForReborn !== true && nextRunStatus === "stopped" && resumableChannelRun(body)) {
      rest = "stopped";
    }
    if (!rest) return false;
    const changed = await tx.query({ name: "machine_lifecycle_instance_rest_v1", text: `UPDATE data.instances SET
      rest_state=$1,rest_reason=NULL,version=version+1,updated_at=GREATEST(updated_at,$2)
      WHERE instance_id=$3 AND run_id=$4 AND status='offline' AND rest_state IS DISTINCT FROM $1
        AND (rest_state IS NULL OR rest_state<>'stopped')
        AND ($1='stopped' OR rest_state IS NULL OR rest_state<>'wake_failed')
        AND (NOT $5::boolean OR rest_state IS NULL OR rest_state='interrupted')
      RETURNING instance_id`, values: [rest, input.at, instanceId, runId, refineOnly], maxRows: 1 });
    return changed.length > 0;
  }

  private async updateSchedule(tx: DatabaseTransaction, runId: string, body: Record<string, unknown>,
    eventType: string, payload: Record<string, unknown>, status: string | undefined, at: string) {
    const { automationOccurrenceId: occurrenceId, automationId } = automationRunIdentity(body);
    if (!occurrenceId || !automationId || !status) return;
    if (eventType === "machine_spawn_result" && payload.ok !== true || eventType === "machine_run_exited") {
      const succeeded = status === "completed";
      const detail = succeeded ? null : failureDetail(payload);
      await tx.query({ name: "machine_lifecycle_occurrence_finish_v2", text: `UPDATE
        data.automation_occurrences SET status=$1,lease_owner=NULL,lease_until=NULL,
        error_code=$2,error_message=$3,updated_at=$4,finished_at=$4
        WHERE occurrence_id=$5 AND automation_id=$6 AND run_id=$7
          AND status IN ('prepared','dispatched')`, values: [succeeded ? "dispatched" : "failed",
      succeeded ? null : eventType === "machine_spawn_result" ? "machine_spawn_failed" : "machine_run_failed",
      detail, at, occurrenceId, automationId, runId], maxRows: 0 });
      await tx.query({ name: "machine_lifecycle_task_finish_v2", text: `UPDATE data.automations
        SET last_error=$1,version=version+1,updated_at=$2 WHERE automation_id=$3 AND last_run_id=$4`,
      values: [detail, at, automationId, runId], maxRows: 0 });
    }
  }

  private async reconcileSnapshot(tx: DatabaseTransaction, input: { spaceId: string; ownerUserId: string; machineId: string;
    hostId: string; channelId: string; payload: Record<string, unknown>; at: string;
    registryCausal?: RegistryCausalEvidence }) {
    if (!Array.isArray(input.payload.runs)) return [];
    // A partial snapshot is one Run's progress event: it records progress and
    // never retires a Run, so it neither needs nor advances the snapshot head.
    const complete = input.payload.snapshotComplete === true;
    if (!complete && !input.registryCausal) return [];
    if (complete && input.registryCausal) {
      const accepted = await tx.query<QueryResultRow>({ name: "machine_lifecycle_snapshot_head_v2", text: `INSERT INTO
        data.machine_run_snapshot_heads
        (owner_user_id,machine_id,hostname,channel_id,connection_epoch,registry_sequence,captured_at,updated_at)
        VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8)
        ON CONFLICT (owner_user_id,machine_id,channel_id) DO UPDATE SET
          hostname=EXCLUDED.hostname,
          connection_epoch=EXCLUDED.connection_epoch,registry_sequence=EXCLUDED.registry_sequence,
          captured_at=EXCLUDED.captured_at,updated_at=EXCLUDED.updated_at
        WHERE data.machine_run_snapshot_heads.connection_epoch<EXCLUDED.connection_epoch OR
          (data.machine_run_snapshot_heads.connection_epoch=EXCLUDED.connection_epoch AND
           data.machine_run_snapshot_heads.registry_sequence<EXCLUDED.registry_sequence)
        RETURNING registry_sequence`, values: [input.ownerUserId, input.machineId, input.hostId,
        input.channelId, input.registryCausal.connectionEpoch, input.registryCausal.sequence,
        input.registryCausal.capturedAt, input.at], maxRows: 1 });
      if (!accepted[0]) return [];
    }
    const runIds = new Set<string>();
    const executionKeys = new Set<string>();
    for (const [index, value] of input.payload.runs.entries()) {
      const item = record(value, `payload.runs[${index}]`);
      if (typeof item.runId === "string" && item.runId.trim()) runIds.add(text(item.runId, "runId", 300));
      if (typeof item.executionKey === "string" && item.executionKey.trim()) {
        executionKeys.add(text(item.executionKey, "executionKey", 300));
      }
      if (!item.runId && !item.executionKey) throw new RuntimeControlError(
        "invalid_machine_lifecycle", 400, "Snapshot item requires a Run or execution key");
    }
    const rows = await tx.query<QueryResultRow>({ name: "machine_lifecycle_snapshot_runs_v4", text: `SELECT
      r.run_id,r.status,r.version,r.metadata_json,r.updated_at,i.instance_id,
      i.version AS instance_version,i.status AS instance_status,i.channel_instance_id,
      ${REGISTRATION_AGENT_NAME_SQL} AS agent_name
      FROM data.runs r LEFT JOIN data.instances i ON i.run_id=r.run_id
      ${registrationNameJoinSql("$4")}
      WHERE r.owner_user_id=$1 AND r.channel_id=$2 AND
        (r.status IN ('running','stopping') OR
         (r.status IN (${TERMINAL_RUN_STATUS_SQL}) AND i.status<>'offline'))
        AND r.metadata_json->>'machineId'=$3
      ORDER BY r.run_id LIMIT 1001 FOR UPDATE OF r`,
    values: [input.ownerUserId, input.channelId, input.machineId, input.spaceId], maxRows: 1001 });
    if (rows.length > 1_000) throw new RuntimeControlError(
      "capacity", 409, "Machine snapshot exceeds the bounded live Run capacity");
    const changed = [];
    for (const row of rows) {
      const body = metadata(row);
      const reported = runIds.has(String(row.run_id)) || typeof body.executionKey === "string" &&
        executionKeys.has(body.executionKey);
      if (!complete && !reported) continue;
      if (isTerminalRunStatus(row.status)) {
        if (!complete) continue;
        const retired = await tx.query({
          name: "machine_lifecycle_snapshot_terminal_instance_offline_v1", text: `UPDATE
          data.instances SET status='offline',version=version+1,updated_at=GREATEST(updated_at,$1)
          WHERE instance_id=$2 AND run_id=$3 AND version=$4 AND status<>'offline'
          RETURNING instance_id`, values: [input.at, row.instance_id, row.run_id,
          row.instance_version], maxRows: 1 });
        if (retired[0]) changed.push(String(row.run_id));
        continue;
      }
      if (reported) {
        // Progress requires the exact Run AND execution binding, plus an accepted
        // causal snapshot. Legacy identity-only snapshots still reconcile presence.
        const item = input.registryCausal ? input.payload.runs.find((value) => {
          const candidate = value as Record<string, unknown>;
          return candidate.runId === row.run_id && typeof candidate.executionKey === "string" &&
            candidate.executionKey === body.executionKey;
        }) : undefined;
        if (item && typeof item === "object") await recordMessageExecutions(tx, {
          spaceId: input.spaceId, channelId: input.channelId, runId: String(row.run_id), instanceId: row.instance_id,
          agentName: row.agent_name,
          channelInstanceId: row.channel_instance_id, at: input.at,
        }, (item as Record<string, unknown>).taskExecution);
        const progress = invocationProgress(item, input.at);
        if (progress) await tx.query({ name: "machine_lifecycle_invocation_progress_v1", text: `UPDATE
          data.runs SET metadata_json=jsonb_set(metadata_json,'{invocationProgress}',$1::jsonb),
          version=version+1,updated_at=$2 WHERE run_id=$3 AND owner_user_id=$4 AND version=$5`,
          values: [JSON.stringify(progress), input.at, row.run_id, input.ownerUserId, row.version], maxRows: 0 });
        // Progress does not retire a Run or alter the active-run routing cache.
        continue;
      }
      if (input.registryCausal && !snapshotMayRetireRun(
        body, row.updated_at, input.registryCausal, input.at,
      )) continue;
      await tx.query({ name: "machine_lifecycle_snapshot_run_exit_v1", text: `UPDATE data.runs SET
        status='exited',version=version+1,updated_at=$1,finished_at=$1
        WHERE run_id=$2 AND owner_user_id=$3 AND version=$4 RETURNING run_id`,
      values: [input.at, row.run_id, input.ownerUserId, row.version], maxRows: 1 });
      if (row.instance_id && row.instance_status !== "offline") await tx.query({
        name: "machine_lifecycle_snapshot_instance_offline_v1", text: `UPDATE data.instances SET
          status='offline',version=version+1,updated_at=$1 WHERE instance_id=$2 AND version=$3
          RETURNING instance_id`, values: [input.at, row.instance_id, row.instance_version], maxRows: 1 });
      // The daemon no longer has the process: it ended without a stop or a
      // sleep report, so the Instance was interrupted (or was stopping).
      const rest = row.instance_id
        ? runEndRestState({ metadata: body, previousRunStatus: String(row.status), nextRunStatus: "exited" })
        : null;
      if (rest) await tx.query({ name: "machine_lifecycle_snapshot_instance_rest_v1", text: `UPDATE
        data.instances SET rest_state=$1,version=version+1,updated_at=GREATEST(updated_at,$2)
        WHERE instance_id=$3 AND run_id=$4 AND status='offline' AND rest_state IS NULL
        RETURNING instance_id`, values: [rest, input.at, row.instance_id, row.run_id], maxRows: 1 });
      changed.push(String(row.run_id));
    }
    return changed;
  }
}

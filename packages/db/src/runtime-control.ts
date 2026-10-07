import { localLlmUsage } from "@xmatrix/protocol";
import { hostnameMetadata } from "./hostname-metadata.js";
import { readFirstMessageLaunchChoices } from "./first-message-launch-choice.js";
import { initialMessageSource } from "./runtime-initial-input.js";
import { publicLaunchFailureCode, publicLaunchFailureMessage, publicRuntimeErrorCode } from "./runtime-public-failure.js";
import { requireRunRegistrationAccess } from "./agent-registration-run.js";
import type { QueryResultRow } from "pg";
import { decodeInvocationPageCursor, encodeInvocationPageCursor, type InvocationPagePosition } from "./runtime-invocation-cursor.js";
import { readInvocationProgress } from "./runtime-invocation-progress.js";
import { readContinuationSource } from "./runtime-continuation-source.js";
import { queryMessageAgentTargets } from "./message-agent-targets.js";
import { queryMessageExecutions, selectRunExecutionSources } from "./runtime-message-executions.js";
import { ACTIVE_RUN_STATUS_SQL, isActiveRunStatus, isRunStatus, isTerminalRunStatus, validRunTransition, type RunStatus, PREPARATION_REJECTION_MESSAGES, REGISTRATION_PREPARATION_REJECTION_CODES, preparationRejectionMessage, parseDecisionAnswerFailure,
  parsePresentedRoutingDecision, rebornFailureReason, agentAvatarUrlFromMetadata, isAgentStatus,
  isLiveAgentStatus, LIVE_AGENT_STATUS_SQL, normalizeAgentPresetRuntime, type AgentStatus, type AgentLaunchState,
  type RuntimeOperationFailure, type SerializedAgentContinuation, type SerializedAgentLaunch, type SerializedAgentInvocationRejection, type SerializedAgentStop, type AgentStopPhase, type AgentInvocationQueryPage, type AgentLaunchActivity, type InvocationDiagnosticsReport } from "@xmatrix/protocol";
import { commandDigest as digest } from "./command-digest.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import {
  requireChannelCapability,
  type ChannelCapability,
  type ChannelCapabilityGrant,
} from "./channel-capability-policy.js";
import { PostgresEntitySpaceDirectory, type EntitySpaceRouteKind } from "./entity-directory.js";
import {
  PostgresChannelSpaceDirectory,
  WritableSpacePlacements,
  type SpacePlacement,
} from "./placement.js";
import {
   NaturalKeyError, reserveNaturalKey } from "./natural-keys.js";
import { commandFields } from "./command-fields.js";
import { ControlError } from "./control-error.js";

const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
type InstanceStatus = AgentStatus;

export class RuntimeControlError extends ControlError {
  override name = "RuntimeControlError";
}

const runtimeCapabilityError = (failure: {
  code: "channel_not_found"; status: 404; message: string;
}) => new RuntimeControlError(failure.code, failure.status, failure.message);

export function runtimeChannelCapability(tx: DatabaseTransaction, channelId: string, userId: string,
  capability: Extract<ChannelCapability,
    "runtime_history_read" | "runtime_new_work" | "runtime_terminalize">,
): Promise<ChannelCapabilityGrant> {
  return requireChannelCapability(tx, { channelId, principal: { kind: "user", id: userId },
    capability, error: runtimeCapabilityError });
}

const { text, integer, object: record } = commandFields((field) =>
  new RuntimeControlError("invalid_runtime_request", 400, `${field} is invalid`));

/** Runtime-owned cancellation fence. Call inside the scheduling transaction so
 * revocation and occupancy release commit together. This is not process-death evidence. */
export async function cancelRunExecution(tx: DatabaseTransaction, input: {
  runId: string; ownerUserId: string; channelId: string; at: string;
  reason: "timeout" | "owner";
}): Promise<void> {
  const rows = await tx.query<QueryResultRow>({ name: "runtime_execution_cancel_lock_v1",
    text: `SELECT r.*,i.instance_id FROM data.runs r LEFT JOIN data.instances i
      ON i.run_id=r.run_id WHERE r.run_id=$1 FOR UPDATE OF r`,
    values: [input.runId], maxRows: 1 });
  const run = rows[0];
  if (!run || run.owner_user_id !== input.ownerUserId || run.channel_id !== input.channelId) {
    throw new RuntimeControlError("conflict", 409, "Scheduled execution ownership does not match");
  }
  const body = metadata(run);
  if (body.executionCancellation && isTerminalRunStatus(run.status)) return;
  if (!isActiveRunStatus(run.status)) {
    throw new RuntimeControlError("conflict", 409, "Run is already terminal");
  }
  const cancellation = { reason: input.reason, requestedAt: input.at,
    processCleanup: { status: "pending", attempts: 0, nextAttemptAt: input.at } };
  await tx.query({ name: "runtime_execution_cancel_v1", text: `UPDATE data.runs
    SET status='failed',version=version+1,updated_at=$2,finished_at=$2,
      metadata_json=metadata_json || $3::jsonb WHERE run_id=$1`,
    values: [input.runId, input.at, JSON.stringify({ executionCancellation: cancellation,
      terminalError: input.reason === "timeout" ? "Execution deadline exceeded; execution cancelled"
        : "Execution cancelled by its owner" })], maxRows: 0 });
  await tx.query({ name: "runtime_execution_cancel_launch_v1", text: `UPDATE data.agent_launches
    SET state='cancelled',retryable=false,lease_owner=NULL,lease_until=NULL,
      version=version+1,updated_at=$2,finished_at=$2 WHERE run_id=$1
      AND state NOT IN ('cancelled','failed')`, values: [input.runId, input.at], maxRows: 0 });
  await expireInstanceTraceAccess(tx, run.instance_id, input.at);
}

function runStatus(value: unknown): RunStatus {
  const result = text(value, "status", 32) as RunStatus;
  if (!isRunStatus(result)) throw new RuntimeControlError(
    "invalid_runtime_request", 400, "run status is invalid");
  return result;
}

function instanceStatus(value: unknown): InstanceStatus {
  const result = text(value, "status", 32);
  if (!isAgentStatus(result)) throw new RuntimeControlError(
    "invalid_runtime_request", 400, "instance status is invalid");
  return result;
}

function result(entityId: string, entityVersion: number, extra: Record<string, unknown> = {}) {
  return { entityId, entityVersion, projectionMutations: [], recipientChanges: [], ...extra };
}

async function replay(tx: DatabaseTransaction, spaceId: string, commandId: string,
  kind: string, requestDigest: string, legacyRequestDigest = requestDigest): Promise<Record<string, unknown> | null> {
  const rows = await tx.query<QueryResultRow>({ name: "runtime_replay_read_v1", text: `SELECT
    command_kind,request_digest,result_json FROM control.scoped_control_command_replays
    WHERE scope_kind='space' AND scope_id=$1 AND command_id=$2 AND expires_at>clock_timestamp() LIMIT 1`,
  values: [spaceId, commandId], maxRows: 1 });
  if (!rows[0]) return null;
  if (rows[0].command_kind !== kind ||
      rows[0].request_digest !== requestDigest && rows[0].request_digest !== legacyRequestDigest) {
    throw new RuntimeControlError("idempotency_mismatch", 409, "command id was reused");
  }
  return { ...(rows[0].result_json as Record<string, unknown>), reused: true };
}

async function storeReplay(tx: DatabaseTransaction, spaceId: string, commandId: string,
  kind: string, requestDigest: string, value: Record<string, unknown>, at: string) {
  await tx.query({ name: "runtime_replay_write_v1", text: `INSERT INTO control.scoped_control_command_replays
    (scope_kind,scope_id,command_id,command_kind,request_digest,result_json,created_at,expires_at)
    VALUES ('space',$1,$2,$3,$4,$5::jsonb,$6,$7)`, values: [spaceId, commandId, kind,
    requestDigest, JSON.stringify(value), at,
    new Date(Date.parse(at) + REPLAY_TTL_MS).toISOString()], maxRows: 0 });
}

export async function commitRuntime(tx: DatabaseTransaction, spaceId: string,
  value: Record<string, unknown>, at: string,
  names = { head: "runtime_control_head_advance_v1", outbox: "runtime_outbox_v1" }) {
  const heads = await tx.query<QueryResultRow>({ name: names.head, text: `UPDATE
    data.space_control_heads SET commit_sequence=commit_sequence+1,updated_at=$2
    WHERE space_id=$1 RETURNING commit_sequence`, values: [spaceId, at], maxRows: 1 });
  const commitSequence = Number(heads[0]?.commit_sequence);
  if (!Number.isSafeInteger(commitSequence) || commitSequence < 1) throw new RuntimeControlError(
    "space_control_head_missing", 500, "Space control head is unavailable");
  await writeOutbox(tx, {
    name: names.outbox,
    outboxId: `space-control:${spaceId}:${commitSequence}`,
    spaceId,
    topic: "space-control",
    aggregateKind: "runtime",
    aggregateId: String(value.entityId),
    aggregateSequence: commitSequence,
    payload: value,
    at,
  });
}

export async function expireInstanceTraceAccess(tx: DatabaseTransaction, instanceId: unknown, at: string) {
  if (!instanceId) return;
  await tx.query({ name: "runtime_trace_expire_instance_v1", text: `UPDATE data.trace_access_grants SET
    status='expired',version=version+1,decided_at=COALESCE(decided_at,$2),
    expires_at=CASE WHEN expires_at IS NULL OR expires_at>$2 THEN $2 ELSE expires_at END
    WHERE instance_id=$1 AND duration='once' AND status IN ('pending','approved')`,
  values: [instanceId, at], maxRows: 0 });
}

function metadata(row: QueryResultRow, field = "metadata_json") {
  const value = row[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function normalizedAgentName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function runtimeInstanceCursor(value: unknown): [number, string] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value) throw new RuntimeControlError(
    "invalid_runtime_request", 400, "cursor is invalid");
  try {
    const decoded = JSON.parse(value) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        !Number.isSafeInteger(decoded[0]) || Number(decoded[0]) < 1 ||
        typeof decoded[1] !== "string" || !decoded[1]) {
      throw new Error("invalid cursor");
    }
    return [Number(decoded[0]), decoded[1]];
  } catch {
    throw new RuntimeControlError("invalid_runtime_request", 400, "cursor is invalid");
  }
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new Date(value as string | Date).toISOString();
}

function invocationRunActivity(row: QueryResultRow): AgentLaunchActivity | undefined {
  if (!row.run_status) return undefined;
  const runMetadata = metadata(row, "run_metadata_json");
  const progress = readInvocationProgress(runMetadata.invocationProgress);
  return {
      runStatus: String(row.run_status),
      ...(row.instance_status ? { instanceStatus: String(row.instance_status) } : {}),
      ...(typeof runMetadata.hostname === "string" || typeof runMetadata.hostName === "string" || typeof runMetadata.hostId === "string"
        ? { hostName: String(runMetadata.hostname || runMetadata.hostName || runMetadata.hostId).slice(0, 160) } : {}),
      updatedAt: iso(row.run_updated_at) || new Date(row.updated_at as string | Date).toISOString(),
      ...(row.run_finished_at ? { finishedAt: iso(row.run_finished_at) } : {}),
      ...(typeof progress.phase === "string" ? { phase: progress.phase } : {}),
      ...(Array.isArray(progress.startupSteps) ? { startupSteps: progress.startupSteps as Array<{ phase: string; at: string }> } : {}),
      ...(progress.connectionRetry ? { connectionRetry: progress.connectionRetry as { attempt: number; nextAttemptAt?: string } } : {}),
      ...(typeof progress.observedAt === "string" ? { observedAt: progress.observedAt,
        evidenceStale: Date.now() - Date.parse(progress.observedAt) > 90_000 } : {}),
      ...(typeof progress.wrapperReadyAt === "string" ? { wrapperReadyAt: progress.wrapperReadyAt } : {}),
      ...(typeof progress.wrapperVersion === "string" ? { wrapperVersion: progress.wrapperVersion } : {}),
      ...(progress.operationFailure ? { operationFailure: progress.operationFailure as RuntimeOperationFailure } : {}),
      ...(typeof progress.errorCode === "string" ? { errorCode: progress.errorCode } : {}),
      ...(typeof progress.diagnosticId === "string" ? { diagnosticId: progress.diagnosticId } : {}),
  };
}

function invocationTargetAvatar(row: QueryResultRow): string | undefined {
  const runtime = typeof row.target_runtime === "string" ? row.target_runtime : "custom";
  return agentAvatarUrlFromMetadata({}, normalizeAgentPresetRuntime(runtime) ?? runtime);
}

/** A fenced stop's phase. The Workstation's stop receipt is the only
 * confirmation; a Run that merely left `stopping` some other way is not. */
function stopReceiptPhase(status: string, runMetadata: Record<string, unknown>): AgentStopPhase {
  const evidence = runMetadata.daemonStopEvidence;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence) &&
      (evidence as { schemaVersion?: unknown; kind?: unknown }).schemaVersion === 1 &&
      (evidence as { kind?: unknown }).kind === "stop_succeeded") return "confirmed";
  if (status === "stopping" || status === "starting" || status === "running") return "accepted";
  if (status === "failed") return "failed";
  return "unconfirmed";
}

function serializeAgentStop(row: QueryResultRow): SerializedAgentStop | undefined {
  const runMetadata = metadata(row, "metadata_json");
  const request = runMetadata.stopRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const sourceMessageId = (request as { sourceMessageId?: unknown }).sourceMessageId;
  if (typeof sourceMessageId !== "string" || !sourceMessageId) return undefined;
  const evidence = runMetadata.daemonStopEvidence;
  const confirmedAt = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? iso((evidence as { completedAt?: unknown }).completedAt) : undefined;
  const requestedAt = iso((request as { requestedAt?: unknown }).requestedAt) ?? iso(row.updated_at);
  if (!requestedAt) return undefined;
  const avatar = invocationTargetAvatar(row);
  const ordinal = /^[1-9]\d*$/u.test(String(row.channel_instance_id ?? "")) ? String(row.channel_instance_id) : undefined;
  const machineName = typeof row.machine_name === "string" ? row.machine_name.trim().slice(0, 120) : "";
  const phase = stopReceiptPhase(String(row.status), runMetadata);
  return {
    stopId: `${sourceMessageId}:${row.run_id}`.slice(0, 300),
    channelId: String(row.channel_id), sourceMessageId, runId: String(row.run_id),
    targetName: String(row.target_name || "Agent").slice(0, 80),
    ...(avatar ? { targetAvatarUrl: avatar } : {}),
    ...(ordinal ? { instanceOrdinal: ordinal } : {}),
    ...(machineName ? { machineName } : {}),
    phase, requestedAt, ...(phase === "confirmed" && confirmedAt ? { confirmedAt } : {}),
  };
}

const REBORN_STATES = new Set(["waiting", "prepared", "spawned", "failed"]);

function serializeAgentContinuation(row: QueryResultRow): SerializedAgentContinuation[] {
  const source = readContinuationSource(row.invocation_source_json);
  const activity = invocationRunActivity(row);
  const rebornState = typeof row.reborn_state === "string" && REBORN_STATES.has(row.reborn_state)
    ? row.reborn_state as NonNullable<SerializedAgentContinuation["reborn"]>["state"] : undefined;
  // A reborn intent is shown before its successor Run exists; any other
  // continuation is its successor Run.
  if (!source || (!activity && !rebornState)) return [];
  const previous = metadata(row, "predecessor_metadata_json");
  const terminal = previous.daemonTerminalEvidence as Record<string, unknown> | undefined;
  const handoff = previous.instanceHandoff as Record<string, unknown> | undefined;
  const safeAt = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : undefined;
  const predecessorExitedAt = terminal?.schemaVersion === 1 && terminal.runId === source.sourceRunId &&
    (terminal.kind === "run_exited" || terminal.kind === "stop_succeeded") ? safeAt(terminal.completedAt) : undefined;
  const handoffFencedAt = source.kind === "handoff" && handoff?.schemaVersion === 1 &&
    handoff.runId === source.sourceRunId && handoff.instanceId === source.sourceInstanceId &&
    handoff.sourceMessageId === source.sourceMessageId && handoff.successorInstanceId === source.targetInstanceId
    ? safeAt(handoff.transferredAt) : undefined;
  const avatar = invocationTargetAvatar(row);
  // Only a known reborn failure code is public; any other is `reborn_failed`.
  const errorCode = rebornFailureReason(publicRuntimeErrorCode(row.reborn_error_code)).code;
  return [{ ...source, runId: String(row.run_id), channelId: String(row.channel_id),
    targetName: String(row.target_name),
    ...(avatar ? { targetAvatarUrl: avatar } : {}), createdAt: iso(row.created_at)!,
    ...(activity && row.run_created_at ? { runCreatedAt: iso(row.run_created_at) } : {}),
    ...(rebornState ? { reborn: { state: rebornState, stopRequired: row.reborn_stop_required === true,
      ...(rebornState === "failed" ? { errorCode } : {}), updatedAt: iso(row.reborn_updated_at)! } } : {}),
    ...(activity ? { activity } : {}),
    ...(predecessorExitedAt ? { predecessorExitedAt } : {}), ...(handoffFencedAt ? { handoffFencedAt } : {}) }];
}

function routingDecisionView(value: unknown): SerializedAgentLaunch["routingDecision"] {
  const parsed = parsePresentedRoutingDecision(value);
  if (!parsed) return undefined;
  return { ...parsed, source: parsed.source };
}

function serializeAgentLaunch(row: QueryResultRow): SerializedAgentLaunch {
  const targetAvatarUrl = invocationTargetAvatar(row);
  const errorCode = publicLaunchFailureCode(row.error_code, row.error_message);
  const errorStage = publicRuntimeErrorCode(row.error_stage);
  const errorMessage = row.state === "failed" || row.error_message ? publicLaunchFailureMessage(row.error_code, row.error_message) : undefined;
  const runMetadata = metadata(row, "run_metadata_json");
  const activity = invocationRunActivity(row);
  const sourceMention = typeof runMetadata.sourceMention === "string"
    ? runMetadata.sourceMention : undefined;
  const routingDecision = routingDecisionView(runMetadata.routingDecision);
  return {
    launchId: String(row.launch_id),
    channelId: String(row.channel_id),
    sourceMessageId: String(row.trigger_id),
    ...(row.target_name ? { targetName: String(row.target_name) } : {}),
    ...(targetAvatarUrl ? { targetAvatarUrl } : {}),
    launchKind: String(row.launch_kind),
    ...(sourceMention ? { sourceMention } : {}),
    ...(routingDecision ? { routingDecision } : {}),
    ...(activity ? { activity } : {}),
    runId: String(row.run_id),
    instanceId: String(row.instance_id),
    state: String(row.state) as AgentLaunchState,
    attempt: Number(row.attempt),
    retryable: row.retryable === true,
    ...(row.state === "queued" && row.daemon_offline === true ? { daemonOffline: true } : {}),
    ...(errorStage ? { errorStage } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    ...(row.trigger_committed_at ? { triggerCommittedAt: iso(row.trigger_committed_at) } : {}),
    ...(row.interpret_started_at ? { interpretStartedAt: iso(row.interpret_started_at) } : {}),
    ...(row.prepared_at ? { preparedAt: iso(row.prepared_at) } : {}),
    ...(row.command_durable_at ? { commandDurableAt: iso(row.command_durable_at) } : {}),
    ...(row.wake_requested_at ? { wakeRequestedAt: iso(row.wake_requested_at) } : {}),
    ...(row.admitted_at ? { admittedAt: iso(row.admitted_at) } : {}),
    ...(row.spawned_at ? { spawnedAt: iso(row.spawned_at) } : {}),
    ...(row.connected_at ? { connectedAt: iso(row.connected_at) } : {}),
    ...(row.last_reconciled_at ? { lastReconciledAt: iso(row.last_reconciled_at) } : {}),
    ...(row.first_reply_at ? { firstReplyAt: new Date(row.first_reply_at as string | Date).toISOString() } : {}),
  };
}

const ROUTING_REJECTION_CODES = new Set(["routing_parameter_constraints_invalid", "routing_parameter_models_empty", "routing_parameter_workspaces_empty", "routing_parameter_catalog_invalid", "routing_parameter_catalog_unavailable", "routing_parameter_invalid_answer", "routing_parameter_jev_aborted", "routing_parameter_jev_invalid_input", "routing_parameter_jev_customer_verification_required", "routing_parameter_jev_auth_failed", "routing_parameter_jev_permission_denied", "routing_parameter_jev_rate_limited", "routing_parameter_jev_evaluation_failed", "routing_no_eligible", "routing_selection_unconfigured",
  "routing_quota_refresh_failed", "routing_candidates_failed", "routing_syntax_invalid", "routing_parameter_selection_failed", "routing_selection_failed", "routing_evidence_unavailable",
  ...REGISTRATION_PREPARATION_REJECTION_CODES]);

/** A typed domain rejection code: a bounded server identifier, never provider or user text. */
const TYPED_REGISTRATION_REJECTION = /^[a-z][a-z0-9_]{2,79}$/u;

function serializeInvocationRejections(row: QueryResultRow): SerializedAgentInvocationRejection[] {
  const result = metadata(row, "result_json");
  if (!Array.isArray(result.rejected) || typeof result.channelId !== "string" ||
      typeof result.sourceMessageId !== "string") return [];
  return result.rejected.slice(0, 50).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const value = raw as Record<string, unknown>;
    if (typeof value.sourceMention !== "string" || !/^[@＠]/u.test(value.sourceMention) ||
        value.sourceMention.length > 4_500 || typeof value.targetRef !== "string") return [];
    const known = typeof value.code === "string" && Object.hasOwn(PREPARATION_REJECTION_MESSAGES, value.code);
    const typed = !known && typeof value.code === "string" && TYPED_REGISTRATION_REJECTION.test(value.code);
    const code = known || typed ? String(value.code) : "invocation.preparation_rejected";
    return [{ invocationId: `${row.command_id}:${row.rejection_ordinal === undefined ? index : Number(row.rejection_ordinal) - 1}`, channelId: String(result.channelId),
      sourceMessageId: String(result.sourceMessageId), sourceMention: value.sourceMention,
      targetRef: value.targetRef.slice(0, 300), code,
      ...(routingDecisionView(value.routingDecision) ? { routingDecision: routingDecisionView(value.routingDecision) } : {}),
      message: known ? preparationRejectionMessage(code, value.answerFailure)!
        : "This invocation could not be prepared. Review its address and Agent configuration.",
      rejectedAt: iso(row.created_at)!, evidenceExpiresAt: iso(row.expires_at)! }];
  });
}

function launchRequest(input: { requestId: string; launchId: string; channelId: string }) {
  return { requestId: text(input.requestId, "requestId", 200), launchId: text(input.launchId, "launchId", 300),
    channelId: text(input.channelId, "channelId", 300) };
}

/** The locked Instance row, which must belong to the acting owner. */
function ownedInstanceRow(rows: readonly QueryResultRow[], actorUserId: string): QueryResultRow {
  const current = rows[0];
  if (!current) throw new RuntimeControlError("not_found", 404, "Instance not found");
  if (current.owner_user_id !== actorUserId) throw new RuntimeControlError("forbidden", 403, "Instance owner mismatch");
  return current;
}

/** The workspace a Run or Instance row was started in, when it names one. */
function workspaceField(row: QueryResultRow): { workspace?: { machineId: string; canonicalCwd: string } } {
  return row.workspace_machine_id && row.workspace_canonical_cwd ? { workspace: {
    machineId: String(row.workspace_machine_id), canonicalCwd: String(row.workspace_canonical_cwd) } } : {};
}

export function serializePostgresRun(row: QueryResultRow) {
  const body = metadata(row);
  const error = typeof body.terminalError === "string" && body.terminalError.trim()
    ? body.terminalError.trim() : undefined;
  return { id: String(row.run_id), runId: String(row.run_id), ownerUserId: String(row.owner_user_id),
    channelId: String(row.channel_id),
    ...workspaceField(row),
    status: String(row.status), version: Number(row.version), metadata: body,
    ...(error ? { error } : {}), ...(row.instance_id ? { instanceId: String(row.instance_id) } : {}),
    ...(row.instance_status ? { instanceStatus: String(row.instance_status) } : {}),
    ...(row.instance_version === null || row.instance_version === undefined ? {}
      : { instanceVersion: Number(row.instance_version) }),
    ...(row.instance_channel_instance_id ? { channelInstanceId: Number(row.instance_channel_instance_id) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}) };
}

function serializedInstance(row: QueryResultRow) {
  return { id: String(row.instance_id), instanceId: String(row.instance_id), runId: String(row.run_id),
    channelId: String(row.channel_id), channelInstanceId: Number(row.channel_instance_id),
    ...workspaceField(row),
    status: String(row.status), version: Number(row.version),
    ...(row.run_status ? { runStatus: String(row.run_status) } : {}),
    ...(row.run_metadata_json === undefined ? {} : { runMetadata: metadata(row, "run_metadata_json") }),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

export class PostgresRuntimeRepository {
  private readonly channelDirectory: PostgresChannelSpaceDirectory;
  private readonly entityDirectory: PostgresEntitySpaceDirectory;
  private readonly spaces: WritableSpacePlacements;

  /** The Space of a Channel the caller may start new work in. */
  async launchChannelSpace(input: { requestId: string; channelId: string; actorUserId: string }): Promise<{ spaceId: string }> {
    const placement = await this.channelPlacement(input.requestId, input.channelId,
      "runtime.launch.channel.locate", "runtime.launch.placement");
    return this.spaces.transaction(input.requestId, "runtime.launch.channel", placement, async tx => {
      const channel = await runtimeChannelCapability(tx, input.channelId, input.actorUserId, "runtime_new_work");
      if (channel.spaceId !== placement.spaceId) throw new RuntimeControlError("conflict", 409, "Space changed");
      return { spaceId: channel.spaceId };
    });
  }

  /** Bounded historical outcomes only. They neither reserve capacity nor authorize a launch. */
  async recordRoutingRejections(input: { channelId: string; sourceMessageId: string; actorUserId: string;
    rejected: Array<{ sourceMention: string; code: string; routingDecision?: unknown;
      answerFailure?: unknown }> }) {
    const channelId = text(input.channelId, "channelId", 300);
    const sourceMessageId = text(input.sourceMessageId, "sourceMessageId", 160);
    const commandId = `routing-preflight:${sourceMessageId}`;
    if (!Array.isArray(input.rejected) || !input.rejected.length || input.rejected.length > 50)
      throw new RuntimeControlError("invalid_runtime_request", 400, "Invalid rejection count");
    const rejected = input.rejected.map(item => {
      if (!ROUTING_REJECTION_CODES.has(item.code) && !TYPED_REGISTRATION_REJECTION.test(item.code)) {
        throw new RuntimeControlError("invalid_runtime_request", 400, "Invalid rejection code");
      }
      const sourceMention = text(item.sourceMention, "sourceMention", 4500);
      if (!/^[@＠]/u.test(sourceMention))
        throw new RuntimeControlError("invalid_runtime_request", 400, "Invalid source mention");
      const answerFailure = item.code === "routing_parameter_invalid_answer"
        ? parseDecisionAnswerFailure(item.answerFailure) : undefined;
      return { sourceMention, targetRef: "auto", code: item.code,
        ...(answerFailure ? { answerFailure } : {}),
        ...(item.routingDecision ? { routingDecision: routingDecisionView(item.routingDecision) } : {}) };
    });
    const placement = await this.channelPlacement(commandId, channelId,
      "runtime.routing-rejections.locate", "runtime.routing-rejections.placement");
    // Evidence varies across retries. The first committed outcome stays immutable.
    const requestDigest = await digest({ channelId, sourceMessageId, actorUserId: input.actorUserId });
    return this.spaces.transaction(commandId, "runtime.routing-rejections.record", placement, async tx => {
      const channel = await runtimeChannelCapability(tx, channelId, input.actorUserId, "runtime_new_work");
      if (channel.spaceId !== placement.spaceId) throw new RuntimeControlError("conflict", 409, "Space changed");
      const source = await initialMessageSource(tx, { spaceId: channel.spaceId, channelId, messageId: sourceMessageId, actorUserId: input.actorUserId });
      if (!source) throw new RuntimeControlError("conflict", 409, "Source message changed or unavailable");
      await tx.query({ name: "routing_command_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended('routing-command:'||$1||':'||$2,0))",
        values: [channelId, commandId], maxRows: 1 });
      const prior = await replay(tx, channel.spaceId, commandId, "routing_preflight_rejections_v1", requestDigest);
      if (prior) return prior;
      const result = { channelId, sourceMessageId, rejected };
      await storeReplay(tx, channel.spaceId, commandId, "routing_preflight_rejections_v1", requestDigest, result, new Date().toISOString());
      return result;
    });
  }

  constructor(private readonly database: AuthorityDatabase, _directoryShardId?: string) {
    if (database.cacheMode !== "disabled") throw new RuntimeControlError(
      "cached_authority_forbidden", 500, "Runtime authority requires uncached PostgreSQL");
    this.channelDirectory = new PostgresChannelSpaceDirectory(database);
    this.entityDirectory = new PostgresEntitySpaceDirectory(database);
    this.spaces = new WritableSpacePlacements(database, () => new RuntimeControlError(
      "space_placement_unavailable", 503, "Space placement is unavailable", true));
  }

  /** The writable placement of a Channel's Space; `locate` and `operation` name the two lookups. */
  private async channelPlacement(requestId: string, channelId: string, locate: string,
    operation: string): Promise<SpacePlacement> {
    const route = await this.channelDirectory.resolve({ requestId, operation: locate }, channelId);
    if (!route) throw new RuntimeControlError("channel_not_found", 404, "Channel not found");
    return this.spaces.resolve(requestId, operation, route.spaceId);
  }

  private async mutationPlacement(
    commandId: string, kind: string, input: Record<string, unknown>,
  ): Promise<SpacePlacement> {
    const channelKinds = new Set(["natural_key_reserve"]);
    let spaceId: string | null = null;
    if (channelKinds.has(kind)) {
      const channelId = text(input.channelId, "channelId", 300);
      spaceId = (await this.channelDirectory.resolve(
        { requestId: commandId, operation: "runtime.channel.locate" }, channelId,
      ))?.spaceId ?? null;
    } else {
      const entityKind: EntitySpaceRouteKind = kind === "run_transition" ? "run" : "instance";
      const entityId = entityKind === "run" ? text(input.runId, "runId", 300)
        : text(input.instanceId, "instanceId", 300);
      spaceId = (await this.entityDirectory.resolve(
        { requestId: commandId, operation: `runtime.${entityKind}.locate` }, entityKind, entityId,
      ))?.spaceId ?? null;
      if (!spaceId) {
        const rows = await this.database.transaction(
          { requestId: commandId, operation: `runtime.${entityKind}.locate-legacy` },
          (tx) => tx.query<QueryResultRow>({ name: "runtime_entity_space_legacy_v1",
            text: entityKind === "run"
              ? `SELECT c.space_id FROM data.runs r JOIN data.channels c ON c.channel_id=r.channel_id
                   WHERE r.run_id=$1 LIMIT 1`
              : `SELECT c.space_id FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
                   JOIN data.channels c ON c.channel_id=r.channel_id WHERE i.instance_id=$1 LIMIT 1`,
            values: [entityId], maxRows: 1 }),
        );
        spaceId = rows[0] ? String(rows[0].space_id) : null;
      }
    }
    if (!spaceId) throw new RuntimeControlError("not_found", 404, "runtime entity not found");
    return this.spaces.resolve(commandId, `runtime.${kind}.placement`, spaceId);
  }

  private async publishRuntimeRoute(
    requestId: string, placement: SpacePlacement, kind: "run" | "instance", entityId: string,
  ): Promise<void> {
    const rows = await this.spaces.transaction(requestId, `runtime.${kind}.directory-source`, placement, (tx) => tx.query<QueryResultRow & {
      entity_version: string | number; route_version: string | number; updated_at: string;
    }>({
      name: `runtime_${kind}_route_source_v1`,
      text: kind === "run"
        ? `SELECT run.version AS entity_version,head.commit_sequence AS route_version,head.updated_at
            FROM data.runs run JOIN data.channels channel ON channel.channel_id=run.channel_id
            JOIN data.space_control_heads head ON head.space_id=channel.space_id
            WHERE channel.space_id=$1 AND run.run_id=$2 LIMIT 1`
        : `SELECT instance.version AS entity_version,head.commit_sequence AS route_version,head.updated_at
            FROM data.instances instance JOIN data.runs run ON run.run_id=instance.run_id
            JOIN data.channels channel ON channel.channel_id=run.channel_id
            JOIN data.space_control_heads head ON head.space_id=channel.space_id
            WHERE channel.space_id=$1 AND instance.instance_id=$2 LIMIT 1`,
      values: [placement.spaceId, entityId], maxRows: 1,
    }));
    if (!rows[0]) throw new RuntimeControlError(
      "entity_directory_source_incomplete", 503, "Runtime directory source is incomplete", true,
    );
    await this.entityDirectory.publish({
      requestId, operation: `runtime.${kind}.directory-publish`,
    }, {
      kind, entityId, spaceId: placement.spaceId, shardId: placement.shardId,
      placementEpoch: placement.placementEpoch, entityVersion: Number(rows[0].entity_version),
      routeVersion: Number(rows[0].route_version), state: "active", updatedAt: rows[0].updated_at,
    });
  }

  async mutate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const kind = text(input.kind, "kind", 80);
    if (!new Set(["natural_key_reserve", "run_transition", "instance_handoff_fence", "instance_transition",
      "instance_connect"]).has(kind)) {
      throw new RuntimeControlError(
      "invalid_runtime_request", 400, "runtime command is invalid");
    }
    const commandId = text(input.commandId, "commandId", 200);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const at = text(input.at, "at", 100);
    if (!Number.isFinite(Date.parse(at))) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "at is invalid");
    const { at: _serverTimestamp, ...request } = input;
    const requestDigest = await digest(request);
    const placement = await this.mutationPlacement(commandId, kind, input);
    const value: Record<string, unknown> = await this.spaces.transaction(commandId, `runtime.${kind}`, placement, async (tx) => {
      const spaceId = placement.spaceId;
      if (kind === "natural_key_reserve") {
        const channelId = text(input.channelId, "channelId", 300);
        if ((await runtimeChannelCapability(
          tx, channelId, actorUserId, "runtime_new_work"
        )).spaceId !== spaceId) {
          throw new RuntimeControlError("conflict", 409, "Channel Space placement changed");
        }
      }
      const prior = await replay(tx, spaceId, commandId, kind, requestDigest);
      if (prior) return prior;
      if (kind === "natural_key_reserve") {
        // A reservation writes no runtime fact, so it advances no commit head.
        const value = { commandId, kind, reused: false, ...await this.reserveNaturalKey(tx, input, at) };
        await storeReplay(tx, spaceId, commandId, kind, requestDigest, value, at);
        return value;
      }
      const fresh = kind === "run_transition" ? await this.transitionRun(tx, input, actorUserId, at)
            : kind === "instance_handoff_fence" ? await this.fenceHandoff(tx, input, actorUserId, at)
              : kind === "instance_connect" ? await this.connectInstance(tx, input, actorUserId, at)
                : await this.transitionInstance(tx, input, actorUserId, at);
      if ("deferred" in fresh && fresh.deferred === true) return fresh;
      const value = { commandId, kind, reused: false, ...fresh };
      await commitRuntime(tx, spaceId, value, at);
      await storeReplay(tx, spaceId, commandId, kind, requestDigest, value, at);
      return value;
    });
    const runId = typeof value.runId === "string" ? value.runId
      : kind === "run_transition" ? text(input.runId, "runId", 300) : null;
    const instanceId = typeof value.instanceId === "string" ? value.instanceId
      : kind === "instance_handoff_fence" || kind === "instance_transition" ||
          kind === "instance_connect"
        ? text(input.instanceId, "instanceId", 300) : null;
    if (kind === "natural_key_reserve") return value;
    if (runId) await this.publishRuntimeRoute(commandId, placement, "run", runId);
    if (instanceId) await this.publishRuntimeRoute(commandId, placement, "instance", instanceId);
    return value;
  }

  /**
   * An Agent message header's tags are stamped from this row by the very
   * transaction that authorizes the message, so the Worker serving the REST
   * send path never has to call the Runtime cell to learn them.
   *
   * Presentation is display state, not a lifecycle transition: it is
   * last-writer-wins, takes no expected version, bumps no instance version,
   * writes no command replay and publishes no route. Racing it against a
   * connect fence would be a bug, not a safeguard.
   *
   * `status` is the live phase (online, busy or idle) the Instance reported
   * with this presentation. A catalog snapshot is ordered against live frames
   * by `updated_at`, so the row must not advance that clock while still saying
   * `online` for an Instance mid-turn. It only moves between live statuses:
   * whether an Instance is live at all stays the lifecycle's to decide.
   */
  async recordInstancePresentation(input: {
    requestId: string;
    actorUserId: string;
    spaceId: string;
    instanceId: string;
    presentation: Record<string, unknown> | null;
    status?: string;
    at: string;
  }): Promise<{ instanceId: string; recorded: boolean; registration?: { ownerUserId: string; machineId: string; harness: string } }> {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId", 300);
    const instanceId = text(input.instanceId, "instanceId", 300);
    const at = text(input.at, "at", 100);
    if (!Number.isFinite(Date.parse(at))) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "at is invalid");
    if (input.status !== undefined && !isLiveAgentStatus(input.status)) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "status is invalid");
    const presentation = input.presentation === null ||
        input.presentation === undefined ||
        Object.keys(input.presentation).length === 0
      ? null
      : input.presentation;
    const placement = await this.spaces.resolve(requestId, "runtime.instance.presentation", spaceId);
    const rows = await this.spaces.transaction(requestId, "runtime.instance.presentation", placement, (tx) => tx.query<QueryResultRow>({
      name: "runtime_instance_presentation_v4",
      // Hibernation can omit the large model catalog from live presentation.
      // Omission is not a withdrawal; only an explicit models field replaces
      // the durable observation, including an empty list that clears it.
      text: `UPDATE data.instances SET presentation_json=
          CASE WHEN NOT (COALESCE($2::jsonb,'{}'::jsonb) ? 'models')
            THEN jsonb_strip_nulls(jsonb_build_object('models',presentation_json->'models',
              'modelsObservedAt',presentation_json->'modelsObservedAt')) ELSE '{}'::jsonb END ||
          CASE WHEN NOT (COALESCE($2::jsonb,'{}'::jsonb) ? 'parameters')
            THEN jsonb_strip_nulls(jsonb_build_object('parameters',presentation_json->'parameters',
              'parametersObservedAt',presentation_json->'parametersObservedAt')) ELSE '{}'::jsonb END || COALESCE($2::jsonb,'{}'::jsonb),updated_at=$3,
          status=CASE WHEN $4::text IS NOT NULL AND status IN (${LIVE_AGENT_STATUS_SQL}) THEN $4::text ELSE status END
        WHERE instance_id=$1 AND EXISTS (SELECT 1 FROM data.runs r
          WHERE r.run_id=data.instances.run_id AND r.owner_user_id=$5)
        RETURNING instance_id,run_id`,
      values: [instanceId, presentation === null ? null : JSON.stringify({ ...presentation, usage: localLlmUsage(presentation.usage as import("@xmatrix/protocol").LlmUsage | undefined) }), at, input.status ?? null, text(input.actorUserId, "actorUserId", 300)],
      maxRows: 1,
    }));
    const binding = rows[0] && input.presentation?.usage ? await this.database.transaction({
      requestId, operation: "runtime.instance.quota-binding",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, tx => tx.query<QueryResultRow>({ name: "runtime_instance_quota_binding_v1", text: `SELECT
        b.owner_user_id,b.machine_id,b.harness FROM data.run_agent_registrations b
        WHERE b.run_id=$1 AND b.space_id=$2`, values: [rows[0].run_id, spaceId], maxRows: 1 })) : [];
    const key = binding[0];
    return { instanceId, recorded: rows.length > 0, ...(key ? { registration: {
      ownerUserId: String(key.owner_user_id), machineId: String(key.machine_id), harness: String(key.harness),
    } } : {}) };
  }

  private async transitionRun(tx: DatabaseTransaction, input: Record<string, unknown>, actorUserId: string,
    at: string) {
    const runId = text(input.runId, "runId", 300);
    const expected = integer(input.expectedVersion, "expectedVersion", 1);
    const status = runStatus(input.status);
    const rows = await tx.query<QueryResultRow>({ name: "runtime_run_transition_lock_v1", text: `SELECT
      r.owner_user_id,r.status,r.version,i.instance_id FROM data.runs r LEFT JOIN data.instances i
      ON i.run_id=r.run_id WHERE r.run_id=$1 FOR UPDATE OF r`, values: [runId], maxRows: 1 });
    const current = rows[0];
    if (!current) throw new RuntimeControlError("not_found", 404, "Run not found");
    if (current.owner_user_id !== actorUserId) throw new RuntimeControlError("forbidden", 403, "Run owner mismatch");
    if (Number(current.version) !== expected || !validRunTransition(String(current.status) as RunStatus, status)) {
      throw new RuntimeControlError("conflict", 409, "Run transition conflicts with current state");
    }
    const terminal = isTerminalRunStatus(status) ? at : null;
    await tx.query({ name: "runtime_run_transition_v1", text: `UPDATE data.runs SET status=$1,
      version=$2,metadata_json=COALESCE($3::jsonb,metadata_json),updated_at=$4,finished_at=$5
      WHERE run_id=$6 AND owner_user_id=$7 AND version=$8 AND status=$9`, values: [status,
    expected + 1, input.metadata === undefined ? null : JSON.stringify(hostnameMetadata(record(input.metadata, "metadata"))),
    at, terminal, runId, actorUserId, expected, current.status], maxRows: 0 });
    if (terminal) await expireInstanceTraceAccess(tx, current.instance_id, at);
    return result(runId, expected + 1);
  }

  private async reserveNaturalKey(tx: DatabaseTransaction, input: Record<string, unknown>, at: string) {
    const scope = text(input.scope, "scope", 20);
    if (scope !== "instance" && scope !== "run" && scope !== "about") throw new RuntimeControlError(
      "invalid_runtime_request", 400, "scope is invalid");
    try {
      const reservation = await reserveNaturalKey(tx, { creationKey: text(input.creationKey, "creationKey", 300),
        channelId: text(input.channelId, "channelId", 300), scope, at,
        ...(scope === "run" ? { channelInstanceId: integer(input.channelInstanceId, "channelInstanceId", 1) } : {}) });
      return { runId: reservation.runId, runOrdinal: reservation.runOrdinal,
        ...(reservation.instanceId ? { instanceId: reservation.instanceId,
          channelInstanceId: reservation.channelInstanceId } : {}) };
    } catch (error) {
      if (error instanceof NaturalKeyError) throw new RuntimeControlError(
        error.code === "natural_key_instance_missing" ? "not_found" : "conflict",
        error.code === "natural_key_instance_missing" ? 404 : 409, error.code);
      throw error;
    }
  }

  private async fenceHandoff(tx: DatabaseTransaction, input: Record<string, unknown>, actorUserId: string,
    at: string) {
    const instanceId = text(input.instanceId, "instanceId", 300);
    const runId = text(input.runId, "runId", 300);
    const rows = await tx.query<QueryResultRow>({ name: "runtime_handoff_lock_v1", text: `SELECT
      r.owner_user_id,r.version AS run_version,r.metadata_json FROM data.instances i
      JOIN data.runs r ON r.run_id=i.run_id WHERE i.instance_id=$1 AND r.run_id=$2 FOR UPDATE OF r`,
    values: [instanceId, runId], maxRows: 1 });
    const current = ownedInstanceRow(rows, actorUserId);
    const body = metadata(current);
    if (body.instanceDeletion !== undefined) throw new RuntimeControlError("conflict", 409,
      "Agent Instance already has a delete fence");
    const existing = body.instanceHandoff as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.sourceMessageId === input.sourceMessageId &&
          existing.successorInstanceId === input.successorInstanceId) return result(instanceId, Number(current.run_version));
      throw new RuntimeControlError("conflict", 409, "Agent Instance was already handed off");
    }
    body.instanceHandoff = { schemaVersion: 1, instanceId, runId,
      successorInstanceId: text(input.successorInstanceId, "successorInstanceId", 300),
      sourceMessageId: text(input.sourceMessageId, "sourceMessageId", 300),
      reason: text(input.reason, "reason", 600), transferredAt: at };
    await tx.query({ name: "runtime_handoff_fence_v1", text: `UPDATE data.runs SET metadata_json=$1::jsonb,
      version=version+1,updated_at=$2 WHERE run_id=$3 AND owner_user_id=$4 AND version=$5`,
    values: [JSON.stringify(hostnameMetadata(body)), at, runId, actorUserId, current.run_version], maxRows: 0 });
    return result(instanceId, Number(current.run_version) + 1);
  }

  private async transitionInstance(tx: DatabaseTransaction, input: Record<string, unknown>,
    actorUserId: string, at: string) {
    const instanceId = text(input.instanceId, "instanceId", 300);
    const expected = integer(input.expectedVersion, "expectedVersion", 1);
    const status = instanceStatus(input.status);
    const rows = await tx.query<QueryResultRow>({ name: "runtime_instance_transition_lock_v1", text: `SELECT
      r.owner_user_id,i.version,i.status,i.run_id,r.status AS run_status,r.version AS run_version,
      r.metadata_json AS run_metadata_json FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
      WHERE i.instance_id=$1 FOR UPDATE OF i,r`, values: [instanceId], maxRows: 1 });
    const current = ownedInstanceRow(rows, actorUserId);
    if (Number(current.version) !== expected) throw new RuntimeControlError("conflict", 409, "Instance version changed");
    const expectedRunId = input.expectedRunId === undefined ? undefined : text(input.expectedRunId, "expectedRunId", 300);
    if (expectedRunId && current.run_id !== expectedRunId) throw new RuntimeControlError(
      "conflict", 409, "Instance no longer belongs to the expected Run");
    const body = metadata(current, "run_metadata_json");
    const deletion = body.instanceDeletion && typeof body.instanceDeletion === "object"
      ? body.instanceDeletion as Record<string, unknown> : undefined;
    const deletePhase = input.deletePhase;
    const terminalRunFence = input.terminal === true && status === "offline" && deletePhase === undefined;
    const hasDeleteField = deletePhase !== undefined || input.expectedRunId !== undefined && !terminalRunFence ||
      input.deleteControlId !== undefined;
    if (hasDeleteField && ((deletePhase !== "prepare" && deletePhase !== "commit") ||
        typeof input.expectedRunId !== "string" || typeof input.deleteControlId !== "string" ||
        deletePhase === "prepare" && input.terminal !== undefined ||
        deletePhase === "commit" && input.terminal !== true)) throw new RuntimeControlError(
      "invalid_runtime_request", 400,
      "Instance delete transition requires an exact phase, Run, control intent, and terminal contract");
    if (deletePhase !== undefined && deletePhase !== "prepare" && deletePhase !== "commit") {
      throw new RuntimeControlError("invalid_runtime_request", 400, "deletePhase is invalid");
    }
    if (body.instanceDeletion !== undefined && deletePhase === undefined) throw new RuntimeControlError(
      "conflict", 409, "A deleted or deleting Instance cannot transition");
    if (deletePhase === "prepare") {
      const fencedRunId = text(expectedRunId, "expectedRunId", 300);
      // A live Instance moves between online, busy and idle with every turn
      // (see recordInstancePresentation); that is not a change this fence guards.
      const sameLifecycle = status === current.status ||
        (isLiveAgentStatus(status) && isLiveAgentStatus(current.status));
      if (!sameLifecycle || deletion) throw new RuntimeControlError("conflict", 409,
        "Instance changed before delete fencing");
      const controlId = text(input.deleteControlId, "deleteControlId", 300);
      body.instanceDeletion = { schemaVersion: 1, state: "pending", instanceId,
        runId: fencedRunId, controlId, requestedAt: at };
      await tx.query({ name: "runtime_instance_delete_prepare_v1", text: `UPDATE data.instances SET
        version=version+1,updated_at=$1 WHERE instance_id=$2 AND run_id=$3 AND version=$4 AND status=$5`,
      values: [at, instanceId, fencedRunId, expected, current.status], maxRows: 0 });
      await tx.query({ name: "runtime_instance_delete_run_fence_v1", text: `UPDATE data.runs SET
        metadata_json=$1::jsonb,version=version+1,updated_at=$2 WHERE run_id=$3 AND owner_user_id=$4 AND version=$5`,
      values: [JSON.stringify(hostnameMetadata(body)), at, fencedRunId, actorUserId, current.run_version], maxRows: 0 });
      return result(instanceId, expected + 1);
    }
    const commitRunId = deletePhase === "commit" ? text(expectedRunId, "expectedRunId", 300) : undefined;
    if (deletePhase === "commit" && (!deletion || deletion.schemaVersion !== 1 ||
        deletion.state !== "pending" || deletion.instanceId !== instanceId ||
        deletion.runId !== commitRunId || deletion.controlId !== input.deleteControlId)) {
      throw new RuntimeControlError("conflict", 409, "Instance delete commit does not match its fence");
    }
    const terminal = input.terminal === true;
    if (terminal && status !== "offline") throw new RuntimeControlError(
      "invalid_runtime_request", 400, "Terminal Instance status must be offline");
    if (!terminal && status !== "offline" &&
        !isActiveRunStatus(current.run_status)) {
      throw new RuntimeControlError("conflict", 409, "A terminal Run cannot resume an Instance");
    }
    if (!terminal && current.status === status) throw new RuntimeControlError("conflict", 409,
      "Instance transition does not change status");
    await tx.query({ name: "runtime_instance_transition_v2", text: `UPDATE data.instances SET
      status=$1,rest_state=CASE WHEN $1='offline' THEN rest_state END,version=version+1,updated_at=$2
      WHERE instance_id=$3 AND run_id=$4 AND version=$5 AND status=$6`,
    values: [status, at, instanceId, current.run_id, expected, current.status], maxRows: 0 });
    const liveRun = isActiveRunStatus(current.run_status);
    if (deletePhase === "commit") {
      body.instanceDeletion = { ...deletion, state: "deleted", completedAt: at };
      await tx.query({ name: "runtime_instance_delete_commit_v1", text: `UPDATE data.runs SET
        status=$1,version=version+1,metadata_json=$2::jsonb,updated_at=$3,
        finished_at=CASE WHEN $4 THEN $3 ELSE finished_at END
        WHERE run_id=$5 AND owner_user_id=$6 AND version=$7 AND status=$8`, values: [
        liveRun ? "stopped" : current.run_status, JSON.stringify(hostnameMetadata(body)), at, liveRun,
        current.run_id, actorUserId, current.run_version, current.run_status], maxRows: 0 });
    } else if (terminal && liveRun) {
      await tx.query({ name: "runtime_instance_terminal_run_v1", text: `UPDATE data.runs SET
        status='stopped',version=version+1,updated_at=$1,finished_at=$1
        WHERE run_id=$2 AND owner_user_id=$3 AND version=$4 AND status=$5`,
      values: [at, current.run_id, actorUserId, current.run_version, current.run_status], maxRows: 0 });
    }
    if (deletePhase === "commit" || terminal) await expireInstanceTraceAccess(tx, instanceId, at);
    return result(instanceId, expected + 1);
  }

  private async connectInstance(tx: DatabaseTransaction, input: Record<string, unknown>,
    actorUserId: string, at: string) {
    const instanceId = text(input.instanceId, "instanceId", 300);
    const rows = await tx.query<QueryResultRow>({ name: "runtime_instance_connect_lock_v2", text: `SELECT
      instance.status AS instance_status,instance.version AS instance_version,run.run_id,run.channel_id,
      run.owner_user_id,run.status AS run_status,run.version AS run_version,run.metadata_json,
      launch.launch_id,launch.state AS launch_state
      FROM data.instances instance JOIN data.runs run ON run.run_id=instance.run_id
      LEFT JOIN data.agent_launches launch ON launch.instance_id=instance.instance_id
        AND launch.run_id=run.run_id
      WHERE instance.instance_id=$1 FOR UPDATE OF instance,run`, values: [instanceId], maxRows: 1 });
    const current = ownedInstanceRow(rows, actorUserId);
    const currentVersion = Number(current.instance_version);
    if (input.expectedVersion !== undefined &&
        integer(input.expectedVersion, "expectedVersion", 1) !== currentVersion) {
      const liveRun = new Set(["starting", "running"]).has(String(current.run_status));
      const connectable = isAgentStatus(current.instance_status);
      // A timed-out handshake retries with the version it observed before the
      // predecessor committed. Continue from the live row instead of 409.
      if (!liveRun || !connectable) {
        throw new RuntimeControlError("conflict", 409, "Instance changed before connection claim");
      }
    }
    if (!new Set(["starting", "running"]).has(String(current.run_status))) throw new RuntimeControlError(
      "conflict", 409, "A terminal Run cannot connect an Instance");
    if (!isAgentStatus(current.instance_status)) {
      throw new RuntimeControlError("conflict", 409, "Instance state cannot connect");
    }
    await requireRunRegistrationAccess(tx, { runId: String(current.run_id), channelId: String(current.channel_id),
      phase: current.run_status === "starting" ? "admission" : "continuation",
      error: (code, status) => new RuntimeControlError(code, status, "Registration no longer authorizes this Run") });
    // Every authenticated transport claims a new version, including reconnects
    // while the predecessor still looks online. Its close is fenced by this CAS.
    // A connected Instance is live again, whatever rest it woke from.
    await tx.query({ name: "runtime_instance_connect_online_v2",
      text: "UPDATE data.instances SET status='online',rest_state=NULL,rest_reason=NULL,version=version+1,updated_at=$2 WHERE instance_id=$1",
      values: [instanceId, at], maxRows: 0 });
    if (current.run_status === "starting") await tx.query({ name: "runtime_instance_connect_run_v1",
      text: "UPDATE data.runs SET status='running',version=version+1,updated_at=$2 WHERE run_id=$1",
      values: [current.run_id, at], maxRows: 0 });
    if (current.launch_id && current.launch_state !== "connected") await tx.query({
      name: "runtime_instance_connect_launch_v1", text: `UPDATE data.agent_launches SET state='connected',
        retryable=FALSE,daemon_offline=FALSE,error_stage=NULL,error_code=NULL,error_message=NULL,
        lease_owner=NULL,lease_until=NULL,
        version=version+1,updated_at=$2,connected_at=COALESCE(connected_at,$2),
        last_reconciled_at=$2,finished_at=$2 WHERE launch_id=$1`,
      values: [current.launch_id, at], maxRows: 0 });
    return result(instanceId, Number(current.instance_version) + 1, { runId: current.run_id,
      runVersion: Number(current.run_version) + (current.run_status === "starting" ? 1 : 0),
      ...(current.launch_id ? { launchId: current.launch_id, launchState: "connected" } : {}) });
  }

  async invocationDiagnostics(input: { requestId: string; actorUserId: string; channelId?: string;
    runId?: string; sourceMessageIds?: readonly string[]; limit?: number; cursor?: string | null;
    agentProof?: { agentId: string; runId: string; instanceId: string; executionKey: string; channelId: string; spaceId: string } }): Promise<InvocationDiagnosticsReport> {
    const requestId = text(input.requestId, "requestId", 200);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    if (Boolean(input.channelId) === Boolean(input.runId)) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "Select exactly one Channel or Run");
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "Diagnostic message limit must be between 1 and 100");
    if (input.sourceMessageIds !== undefined && (!Array.isArray(input.sourceMessageIds) ||
        input.sourceMessageIds.length > 100)) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "Diagnostic source message count is invalid");
    const runId = input.runId ? text(input.runId, "runId", 300) : undefined;
    if (input.agentProof) {
      // Authenticate the caller's execution independently of the selected
      // diagnostic target. Read authority below still belongs to its Channel.
      const proof = input.agentProof;
      const callerRoute = await this.entityDirectory.resolve(
        { requestId, operation: "runtime.diagnostics.caller.locate" }, "run", proof.runId);
      if (!callerRoute || callerRoute.spaceId !== proof.spaceId) throw new RuntimeControlError(
        "forbidden", 403, "Diagnostic credentials do not match a live Run");
      const callerPlacement = await this.spaces.resolve(requestId, "runtime.diagnostics.caller.placement", callerRoute.spaceId);
      await this.spaces.transaction(requestId, "runtime.diagnostics.caller", callerPlacement, async tx => {
        const [caller] = await tx.query<QueryResultRow>({ name: "runtime_diagnostic_caller_v2", text: `SELECT
          r.owner_user_id,r.channel_id,r.status,r.metadata_json,i.instance_id
          FROM data.runs r JOIN data.instances i ON i.run_id=r.run_id AND i.channel_id=r.channel_id
          WHERE r.run_id=$1 AND i.instance_id=$2 LIMIT 1`, values: [proof.runId,proof.instanceId], maxRows: 1 });
        // A Run acts as its Instance.
        if (!caller || caller.owner_user_id !== actorUserId || caller.instance_id !== proof.agentId ||
            caller.channel_id !== proof.channelId || metadata(caller).executionKey !== proof.executionKey ||
            !["starting", "running"].includes(String(caller.status))) throw new RuntimeControlError(
          "forbidden", 403, "Diagnostic credentials do not match a live Run");
        await requireRunRegistrationAccess(tx, { runId: proof.runId, channelId: proof.channelId,
          phase: caller.status === "starting" ? "admission" : "continuation",
          error: (code, status) => new RuntimeControlError(code, status, "Registration no longer authorizes this Run") });
      });
    }
    const requestedChannel = input.channelId ? text(input.channelId, "channelId", 300) : undefined;
    const route = runId
      ? await this.entityDirectory.resolve({ requestId, operation: "runtime.diagnostics.run.locate" }, "run", runId)
      : await this.channelDirectory.resolve({ requestId, operation: "runtime.diagnostics.channel.locate" }, requestedChannel!);
    if (!route) throw new RuntimeControlError("not_found", 404, "Diagnostic target not found");
    const placement = await this.spaces.resolve(requestId, "runtime.diagnostics.placement", route.spaceId);
    const selection = await this.spaces.transaction(requestId, "runtime.diagnostics.select", placement, async (tx) => {
      const runs = runId ? await tx.query<QueryResultRow>({ name: "runtime_diagnostic_run_v3", text: `SELECT
        run.run_id,run.owner_user_id,run.channel_id,run.status AS run_status,
        run.updated_at AS run_updated_at,run.metadata_json AS run_metadata_json,
        run.finished_at AS run_finished_at,instance.instance_id,instance.status AS instance_status,
        COALESCE(registration.display_name,run.metadata_json->>'agentName') AS target_name,COALESCE(launch.trigger_id,run.invocation_source_json->>'sourceMessageId') AS trigger_id
        FROM data.runs run JOIN data.channels channel ON channel.channel_id=run.channel_id AND channel.space_id=$2
        LEFT JOIN data.instances instance ON instance.run_id=run.run_id
        LEFT JOIN data.run_agent_registrations binding ON binding.run_id=run.run_id
        LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
          AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
          AND registration.harness=binding.harness
        LEFT JOIN data.agent_launches launch ON launch.run_id=run.run_id
        WHERE run.run_id=$1 LIMIT 1`, values: [runId, route.spaceId], maxRows: 1 }) : [];
      if (runId && !runs[0]) throw new RuntimeControlError("not_found", 404, "Diagnostic target not found");
      const channelId = requestedChannel ?? String(runs[0]!.channel_id);
      const channel = await runtimeChannelCapability(tx, channelId, actorUserId, "runtime_history_read");
      if (channel.spaceId !== route.spaceId) throw new RuntimeControlError("conflict", 409, "Diagnostic route changed");
      const explicit = input.sourceMessageIds?.map((id) => text(id, "sourceMessageId", 300));
      const recent = !runId && explicit === undefined ? await tx.query<QueryResultRow>({
        name: "runtime_diagnostic_recent_messages_v1", text: `SELECT message_id FROM data.messages
          WHERE space_id=$1 AND channel_id=$2 ORDER BY timeline_sequence DESC LIMIT $3`,
        values: [route.spaceId, channelId, limit + 1], maxRows: limit + 1 }) : [];
      const runSources = runId ? await selectRunExecutionSources(tx, {
        spaceId: route.spaceId, channelId, runId, limit, explicit,
        ...(runs[0]?.trigger_id ? { triggerId: String(runs[0].trigger_id) } : {}),
      }) : undefined;
      const sourceMessageIds = runSources?.sourceMessageIds
        ?? explicit ?? recent.slice(0, limit).map((row) => String(row.message_id));
      if (runId && explicit && (explicit.length !== sourceMessageIds.length ||
          explicit.some((id) => !sourceMessageIds.includes(id)))) throw new RuntimeControlError(
        "invalid_runtime_request", 400, "Source messages do not match this Run");
      const activity = runs[0] ? invocationRunActivity(runs[0]) : undefined;
      return { channelId, sourceMessageIds, hasOlderMessages: runSources?.hasOlderMessages ?? recent.length > limit,
        ...(runs[0] && activity ? { run: { runId: String(runs[0].run_id),
          activity,
          ...(runs[0].instance_id ? { instanceId: String(runs[0].instance_id) } : {}),
          ...(runs[0].target_name ? { name: String(runs[0].target_name) } : {}) } } : {}) };
    });
    const page = await this.queryAgentLaunches({ requestId, actorUserId, channelId: selection.channelId,
      sourceMessageIds: selection.sourceMessageIds, pageSize: 100, cursor: input.cursor, runId });
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), channelId: selection.channelId,
      sourceMessageIds: selection.sourceMessageIds,
      selection: { kind: runId ? "run" : input.sourceMessageIds ? "messages" : "recent-messages",
        limit: input.sourceMessageIds ? selection.sourceMessageIds.length : limit, hasOlderMessages: selection.hasOlderMessages }, ...(selection.run ? { run: selection.run } : {}),
      launches: page.launches.filter((launch) => !runId || launch.runId === runId).map((launch) => {
        const { sourceMention: _address, errorMessage: _freeformError, targetAvatarUrl: _avatar,
          errorCode, errorStage, ...safe } = launch;
        const code = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_.-]{0,79}$/u.test(value);
        return { ...safe, ...(code(errorCode) ? { errorCode } : {}), ...(code(errorStage) ? { errorStage } : {}) };
      }),
      rejections: runId ? [] : (page.rejections ?? []).map(({ sourceMention: _address, ...safe }) => safe),
      continuations: (page.continuations ?? []).map(({ sourceMention: _address, targetAvatarUrl: _avatar, ...safe }) => safe),
      targets: (page.targets ?? []).map(({ sourceBodyHash: _hash, sourceMention: _mention, ...safe }) => safe),
      executions: (page.executions ?? []).map(({ sourceBodyHash: _hash, ...safe }) => safe),
      nextCursor: page.nextCursor ?? null };
  }

  async replyRecoveryTarget(input: { requestId: string; channelId: string; bindingId: string; actorUserId: string; requireLive?: boolean }) {
    const channelId = text(input.channelId, "channelId", 300);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const bindingId = text(input.bindingId, "bindingId", 64);
    const placement = await this.channelPlacement(input.requestId, channelId,
      "reply-recovery.locate", "reply-recovery.placement");
    return this.spaces.transaction(input.requestId, "reply-recovery.target", placement, async tx => {
      await runtimeChannelCapability(tx, channelId, actorUserId,
        input.requireLive === false ? "runtime_history_read" : "runtime_new_work");
      const row = (await tx.query<QueryResultRow>({ name: "runtime_reply_recovery_target_v3", text: `SELECT
        execution.execution_id,execution.run_id,execution.instance_id,
        run.owner_user_id,run.status,run.metadata_json FROM data.agent_message_executions execution
        JOIN data.runs run ON run.run_id=execution.run_id AND run.channel_id=execution.channel_id
        JOIN data.messages source ON source.space_id=execution.space_id AND source.channel_id=execution.channel_id
          AND source.message_id=execution.source_message_id AND source.body_hash=execution.source_body_hash
          AND execution.source_entity_version BETWEEN COALESCE(source.invocation_input_version,source.entity_version) AND source.entity_version
          AND source.timeline_sequence=execution.source_sequence AND source.deleted_at IS NULL AND source.recalled_at IS NULL
        JOIN data.instances instance ON instance.instance_id=execution.instance_id AND instance.run_id=run.run_id
        WHERE execution.space_id=$1 AND execution.channel_id=$2 AND execution.binding_id=$3
          AND run.owner_user_id=$4 AND execution.expires_at>clock_timestamp()
          AND execution.state IN ('completed','failed','interrupted','unknown') LIMIT 1`,
        values: [placement.spaceId, channelId, bindingId, actorUserId], maxRows: 1 }))[0];
      if (!row) throw new RuntimeControlError("reply_recovery_forbidden", 403, "Saved reply recovery requires the original input and its Run owner");
      if (input.requireLive !== false && !["starting", "running"].includes(String(row.status))) {
        throw new RuntimeControlError("reply_recovery_run_ended", 409, "The original Run has ended; its reply cannot be resent with expired authority");
      }
      const metadata = row.metadata_json ?? {};
      return { channelId, runId: String(row.run_id), instanceId: String(row.instance_id), agentId: String(row.instance_id),
        executionId: String(row.execution_id), ownerUserId: actorUserId,
        executionKey: text(metadata.executionKey, "Run execution binding", 200),
        machineId: text(metadata.machineId, "Run machine", 160), hostId: typeof metadata.hostname === "string" ? metadata.hostname :
          typeof metadata.hostId === "string" ? metadata.hostId : "" };
    });
  }

  async queryAgentLaunches(input: { requestId: string; channelId: string;
    sourceMessageIds: readonly string[]; actorUserId: string; cursor?: string | null; pageSize?: number; runId?: string }): Promise<AgentInvocationQueryPage> {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId", 300);
    if (!Array.isArray(input.sourceMessageIds) || input.sourceMessageIds.length > 100) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "sourceMessageIds exceeds its 100-item bound");
    const sourceMessageIds = [...new Set(input.sourceMessageIds.map((id) => text(id, "sourceMessageId", 300)))];
    const paginated = input.pageSize !== undefined || input.cursor !== undefined;
    const pageSize = input.pageSize ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "pageSize must be between 1 and 100");
    const runFilter = input.runId === undefined ? undefined : text(input.runId, "runId", 300);
    const scope = await digest([channelId, input.actorUserId, [...sourceMessageIds].sort(), ...(runFilter ? [runFilter] : [])]);
    let position: InvocationPagePosition;
    try { position = decodeInvocationPageCursor(input.cursor, scope); }
    catch { throw new RuntimeControlError("invalid_runtime_request", 400, "Invocation cursor does not match this query"); }
    if (sourceMessageIds.length === 0) return { launches: [], ...(paginated ? { nextCursor: null } : {}) };
    const placement = await this.channelPlacement(requestId, channelId,
      "runtime.agent-launches.channel.locate", "runtime.agent-launches.placement");
    return this.spaces.transaction(requestId, "runtime.agent-launches.query", placement, async (tx) => {
      await runtimeChannelCapability(tx, channelId,
        text(input.actorUserId, "actorUserId", 300), "runtime_history_read");
      const rows = position.launch === null ? [] : await tx.query<QueryResultRow>({ name: "runtime_agent_launches_query_v5", text: `SELECT
        launch.*,to_char(launch.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
        COALESCE(registration.display_name,run.metadata_json->>'agentName','Agent') AS target_name,
        binding.harness AS target_runtime,
        run.status AS run_status,run.updated_at AS run_updated_at,run.finished_at AS run_finished_at,
        run.metadata_json AS run_metadata_json,instance.status AS instance_status FROM data.agent_launches launch
        LEFT JOIN data.run_agent_registrations binding ON binding.run_id=launch.run_id
        LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
          AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
          AND registration.harness=binding.harness
        JOIN data.runs run ON run.run_id=launch.run_id AND run.channel_id=launch.channel_id
        LEFT JOIN data.instances instance ON instance.instance_id=launch.instance_id
          AND instance.run_id=launch.run_id
        WHERE launch.channel_id=$1 AND launch.trigger_id=ANY($2::text[])
          AND ($3::timestamptz IS NULL OR (launch.created_at,launch.launch_id)>($3::timestamptz,$4::text))
          AND ($6::text IS NULL OR launch.run_id=$6::text)
        ORDER BY launch.created_at,launch.launch_id LIMIT $5`, values: [channelId, sourceMessageIds,
          position.launch?.[0] ?? null, position.launch?.[1] ?? null, pageSize + 1, runFilter ?? null], maxRows: pageSize + 1 });
      // These are bounded recent command outcomes, not a substitute Run or a
      // replay-based authorization decision. Current Channel access was checked above.
      const outcomes = position.rejection === null || runFilter ? [] : await tx.query<QueryResultRow>({
        name: "runtime_invocation_rejections_v4", text: `SELECT replay.command_id,
          replay.created_at,to_char(replay.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,replay.expires_at,
          item.ordinality AS rejection_ordinal,
          jsonb_build_object('channelId',replay.result_json->'channelId',
            'sourceMessageId',replay.result_json->'sourceMessageId',
            'rejected',jsonb_build_array(item.value)) AS result_json
        FROM control.scoped_control_command_replays replay CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(replay.result_json->'rejected')='array'
            THEN replay.result_json->'rejected' ELSE '[]'::jsonb END) WITH ORDINALITY AS item(value,ordinality)
        WHERE replay.scope_kind='space' AND replay.scope_id=$1 AND replay.command_kind IN ('summon_prepare_resolved_batch_v2','routing_preflight_rejections_v1')
          AND (replay.command_kind<>'routing_preflight_rejections_v1' OR EXISTS (SELECT 1 FROM data.messages source
            WHERE source.space_id=$1 AND source.channel_id=$3 AND source.message_id=replay.result_json->>'sourceMessageId'
              AND COALESCE(source.invocation_input_version,source.entity_version)=1
              AND source.edited_at IS NULL
              AND source.deleted_at IS NULL AND source.recalled_at IS NULL))
          AND replay.command_id=ANY($2::text[]) AND replay.expires_at>clock_timestamp()
          AND replay.result_json->>'channelId'=$3 AND replay.result_json->>'sourceMessageId'=ANY($4::text[])
          AND item.ordinality<=50
          AND ($5::timestamptz IS NULL OR (replay.created_at,replay.command_id,item.ordinality)>
            ($5::timestamptz,$6::text,$7::bigint))
        ORDER BY replay.created_at,replay.command_id,item.ordinality LIMIT $8`, values: [placement.spaceId,
          sourceMessageIds.flatMap((id) => [`product:summon-prepare-v2:${id}`.slice(0, 200), `routing-preflight:${id}`]),
          channelId, sourceMessageIds, position.rejection?.[0] ?? null,
          position.rejection?.[1] ?? null, position.rejection?.[2] ?? null, pageSize + 1], maxRows: pageSize + 1 });
      const continuations = position.continuation === null ? [] : await tx.query<QueryResultRow>({
        // A continuation is read from its durable intent from the moment it is
        // accepted. The chip names the successor registration stored on that
        // intent: a handoff's harness is the one that takes over, a reborn's
        // is its own. The predecessor registration is only the fallback for an
        // intent that predates that key. The Instance is the one on the
        // successor Run: a handoff inserts a new Instance, a reborn rebinds
        // the predecessor. Continuations accepted before intents recorded
        // their source are read from the successor Run below.
        name: "runtime_continuation_invocations_v4", text: `SELECT continuation.*,
          to_char(continuation.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM (
          SELECT intent.successor_run_id AS run_id,intent.channel_id,intent.created_at,
          run.created_at AS run_created_at,run.status AS run_status,run.updated_at AS run_updated_at,
          run.finished_at AS run_finished_at,run.metadata_json AS run_metadata_json,
          intent.run_input_json->'invocationSource' AS invocation_source_json,instance.status AS instance_status,
          COALESCE(successor_registration.display_name,intent.run_input_json->'metadata'->>'agentName',
            registration.display_name,intent.run_input_json->'invocationSource'->>'sourceName','Agent') AS target_name,
          COALESCE(successor_registration.harness,intent.run_input_json->'registration'->'key'->>'harness',
            source_binding.harness) AS target_runtime,
          previous.metadata_json AS predecessor_metadata_json,
          intent.state AS reborn_state,intent.stop_required AS reborn_stop_required,
          intent.error_code AS reborn_error_code,intent.updated_at AS reborn_updated_at
          FROM data.agent_reborn_intents intent
          LEFT JOIN data.runs run ON run.run_id=intent.successor_run_id AND run.channel_id=intent.channel_id
          LEFT JOIN data.run_agent_registrations source_binding ON source_binding.run_id=intent.source_run_id
          LEFT JOIN data.space_agent_registrations registration ON registration.space_id=source_binding.space_id
            AND registration.owner_user_id=source_binding.owner_user_id
            AND registration.machine_id=source_binding.machine_id AND registration.harness=source_binding.harness
          LEFT JOIN data.space_agent_registrations successor_registration
            ON successor_registration.space_id=intent.run_input_json->'registration'->'key'->>'spaceId'
            AND successor_registration.owner_user_id=intent.run_input_json->'registration'->'key'->>'ownerUserId'
            AND successor_registration.machine_id=intent.run_input_json->'registration'->'key'->>'machineId'
            AND successor_registration.harness=intent.run_input_json->'registration'->'key'->>'harness'
          JOIN data.messages message ON message.space_id=$7 AND message.channel_id=intent.channel_id
            AND message.message_id=intent.run_input_json->'invocationSource'->>'sourceMessageId'
            AND (intent.run_input_json->'invocationSource'->>'sourceMessageVersion')::bigint
              BETWEEN COALESCE(message.invocation_input_version,message.entity_version) AND message.entity_version
            AND message.deleted_at IS NULL AND message.recalled_at IS NULL
          LEFT JOIN data.instances instance ON instance.run_id=intent.successor_run_id
          LEFT JOIN data.runs previous ON previous.run_id=intent.source_run_id AND previous.channel_id=intent.channel_id
          WHERE intent.space_id=$7 AND intent.channel_id=$1 AND intent.run_input_json ? 'invocationSource'
            AND intent.run_input_json->'invocationSource'->>'sourceMessageId'=ANY($2::text[])
          UNION ALL
          SELECT run.run_id,run.channel_id,run.created_at,run.created_at AS run_created_at,
          run.status AS run_status,run.updated_at AS run_updated_at,run.finished_at AS run_finished_at,
          run.metadata_json AS run_metadata_json,run.invocation_source_json,instance.status AS instance_status,
          COALESCE(registration.display_name,run.invocation_source_json->>'targetNameAtCreation','Agent') AS target_name,
          binding.harness AS target_runtime,
          previous.metadata_json AS predecessor_metadata_json,
          NULL::text AS reborn_state,NULL::boolean AS reborn_stop_required,
          NULL::text AS reborn_error_code,NULL::timestamptz AS reborn_updated_at
          FROM data.runs run
          LEFT JOIN data.run_agent_registrations binding ON binding.run_id=run.run_id
          LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
            AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
            AND registration.harness=binding.harness
          JOIN data.messages message ON message.space_id=$7 AND message.channel_id=run.channel_id
            AND message.message_id=run.invocation_source_json->>'sourceMessageId'
            AND (run.invocation_source_json->>'sourceMessageVersion')::bigint
              BETWEEN COALESCE(message.invocation_input_version,message.entity_version) AND message.entity_version
            AND message.body_hash=run.invocation_source_json->>'sourceContentHash'
            AND message.author_kind=run.invocation_source_json->>'sourceAuthorKind'
            AND message.author_id=run.invocation_source_json->>'sourceAuthorId'
            AND message.deleted_at IS NULL AND message.recalled_at IS NULL
          LEFT JOIN data.instances instance ON instance.run_id=run.run_id
            AND instance.instance_id=run.invocation_source_json->>'targetInstanceId'
          LEFT JOIN data.runs previous ON previous.run_id=run.invocation_source_json->>'sourceRunId'
            AND previous.channel_id=run.channel_id
          WHERE run.channel_id=$1 AND run.invocation_source_json IS NOT NULL
            AND run.invocation_source_json->>'sourceMessageId'=ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.run_id=run.run_id)
            AND NOT EXISTS (SELECT 1 FROM data.agent_reborn_intents intent WHERE intent.successor_run_id=run.run_id
              AND intent.run_input_json ? 'invocationSource')
          ) continuation
          WHERE ($3::timestamptz IS NULL OR (continuation.created_at,continuation.run_id)>($3::timestamptz,$4::text))
            AND ($5::text IS NULL OR continuation.run_id=$5)
          ORDER BY continuation.created_at,continuation.run_id LIMIT $6`, values: [channelId, sourceMessageIds,
            position.continuation?.[0] ?? null, position.continuation?.[1] ?? null,
            runFilter ?? null, pageSize + 1, placement.spaceId], maxRows: pageSize + 1 });
      if (!paginated && (rows.length > pageSize || outcomes.length > pageSize || continuations.length > pageSize)) throw new RuntimeControlError(
        "agent_launch_query_too_large", 409, "This invocation query requires pagination");
      const launchPage = rows.slice(0, pageSize);
      const rejectionPage = outcomes.slice(0, pageSize);
      const continuationPage = continuations.slice(0, pageSize);
      const lastLaunch = launchPage.at(-1);
      const lastRejection = rejectionPage.at(-1);
      const lastContinuation = continuationPage.at(-1);
      const executionPage = paginated ? await queryMessageExecutions(tx, { spaceId: placement.spaceId,
        channelId, messageIds: sourceMessageIds, limit: pageSize, position: position.execution,
        runId: runFilter, viewerUserId: input.actorUserId })
        : { records: [], next: null };
      const targetPage = paginated ? await queryMessageAgentTargets(tx, { spaceId: placement.spaceId,
        channelId, messageIds: sourceMessageIds, limit: pageSize, position: position.target, runId: runFilter })
        : { records: [], next: null };
      const nextCursor = encodeInvocationPageCursor({
        launch: rows.length > pageSize && lastLaunch
          ? [String(lastLaunch.cursor_created_at), String(lastLaunch.launch_id)] : null,
        rejection: outcomes.length > pageSize && lastRejection
          ? [String(lastRejection.cursor_created_at), String(lastRejection.command_id), Number(lastRejection.rejection_ordinal)] : null,
        continuation: continuations.length > pageSize && lastContinuation
          ? [String(lastContinuation.cursor_created_at), String(lastContinuation.run_id)] : null,
        execution: executionPage.next, target: targetPage.next,
      }, scope);
      // A first message's launch choice is one row per message: the first page carries them all.
      const launchChoices = input.cursor || runFilter ? [] : await readFirstMessageLaunchChoices(tx, channelId, sourceMessageIds);
      // The stop chip reads the same first page. A command fences at most 200
      // Runs; 500 covers a page of messages without a second cursor.
      const stopRows = input.cursor || runFilter ? [] : await tx.query<QueryResultRow>({
        name: "runtime_stop_receipts_v1", text: `SELECT r.run_id,r.channel_id,r.status,r.updated_at,r.metadata_json,
          COALESCE(registration.display_name,r.metadata_json->>'agentName','Agent') AS target_name,
          binding.harness AS target_runtime,machine.name AS machine_name,instance.channel_instance_id
          FROM data.runs r
          JOIN data.messages message ON message.space_id=$3 AND message.channel_id=r.channel_id
            AND message.message_id=r.metadata_json->'stopRequest'->>'sourceMessageId'
            AND message.deleted_at IS NULL AND message.recalled_at IS NULL AND message.edited_at IS NULL
          LEFT JOIN data.run_agent_registrations binding ON binding.run_id=r.run_id
          LEFT JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
            AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
            AND registration.harness=binding.harness
          LEFT JOIN data.machines machine ON machine.owner_user_id=binding.owner_user_id
            AND machine.machine_id=binding.machine_id
          LEFT JOIN data.instances instance ON instance.run_id=r.run_id
          WHERE r.channel_id=$1 AND r.metadata_json ? 'stopRequest'
            AND r.metadata_json->'stopRequest'->>'sourceMessageId'=ANY($2::text[])
          ORDER BY r.updated_at,r.run_id LIMIT 500`,
        values: [channelId, sourceMessageIds, placement.spaceId], maxRows: 500 });
      const stops = stopRows.flatMap(row => {
        const stop = serializeAgentStop(row);
        return stop && stop.channelId === channelId && sourceMessageIds.includes(stop.sourceMessageId) ? [stop] : [];
      });
      return { launches: launchPage.map(serializeAgentLaunch), rejections: rejectionPage.flatMap(serializeInvocationRejections),
        continuations: continuationPage.flatMap(serializeAgentContinuation),
        ...(launchChoices.length ? { launchChoices } : {}),
        ...(stops.length ? { stops } : {}),
        ...(paginated ? { executions: executionPage.records, targets: targetPage.records, nextCursor } : {}) };
    });
  }

  async updateAgentLaunch(input: { requestId: string; launchId: string; channelId: string;
    actorUserId?: string; state: AgentLaunchState; at: string; errorStage?: string;
    errorCode?: string; errorMessage?: string; retryable?: boolean }): Promise<{ launch: SerializedAgentLaunch }> {
    const { requestId, launchId, channelId } = launchRequest(input);
    const placement = await this.channelPlacement(requestId, channelId,
      "runtime.agent-launch.update.locate", "runtime.agent-launch.update.placement");
    return this.spaces.transaction(requestId, "runtime.agent-launch.update", placement, async (tx) => {
      if (input.actorUserId) await runtimeChannelCapability(tx, channelId,
        text(input.actorUserId, "actorUserId", 300), "runtime_terminalize");
      // A Launch's name and runtime are the ones its spawn carries.
      const rows = await tx.query<QueryResultRow>({ name: "runtime_agent_launch_update_lock_v3", text: `SELECT
        launch.*,launch.spawn_payload_json->>'agentName' AS target_name,
        launch.spawn_payload_json->>'runtime' AS target_runtime FROM data.agent_launches launch
        WHERE launch.launch_id=$1 AND launch.channel_id=$2 FOR UPDATE OF launch`,
      values: [launchId, channelId], maxRows: 1 });
      const current = rows[0];
      if (!current) throw new RuntimeControlError("not_found", 404, "Agent Launch not found");
      const target = input.state;
      const currentState = String(current.state) as AgentLaunchState;
      const transitions: Record<AgentLaunchState, readonly AgentLaunchState[]> = {
        // Command issue can wake the daemon before the coordinator's queued
        // settlement commits. Admission and process evidence may therefore
        // legitimately skip the derived queued state.
        prepared: ["queued", "admitted", "spawned", "connected", "failed", "cancelled"],
        queued: ["admitted", "spawned", "connected", "failed", "cancelled"],
        admitted: ["spawned", "connected", "failed", "cancelled"],
        spawned: ["connected", "failed", "cancelled"],
        connected: [], failed: ["prepared", "cancelled"], cancelled: [],
      };
      const lateEvidence = target === "admitted" && ["spawned", "connected"].includes(currentState) ||
        target === "spawned" && currentState === "connected";
      if (lateEvidence) {
        const existingAt = target === "admitted" ? current.admitted_at : current.spawned_at;
        if (existingAt) return { launch: serializeAgentLaunch(current) };
        const at = text(input.at, "at", 100);
        const updated = await tx.query<QueryResultRow>({
          name: "runtime_agent_launch_late_evidence_v1", text: `UPDATE data.agent_launches SET
            admitted_at=CASE WHEN $2='admitted' THEN COALESCE(admitted_at,$3::timestamptz)
              ELSE admitted_at END,
            spawned_at=CASE WHEN $2='spawned' THEN COALESCE(spawned_at,$3::timestamptz)
              ELSE spawned_at END,
            last_reconciled_at=GREATEST(COALESCE(last_reconciled_at,$3::timestamptz),$3::timestamptz),
            version=version+1,updated_at=GREATEST(updated_at,$3::timestamptz)
            WHERE launch_id=$1 RETURNING *`,
          values: [launchId, target, at], maxRows: 1,
        });
        return { launch: serializeAgentLaunch({ ...updated[0], target_name: current.target_name,
          target_runtime: current.target_runtime }) };
      }
      if (!transitions[currentState]?.includes(target)) {
        if (current.state === target) return { launch: serializeAgentLaunch(current) };
        throw new RuntimeControlError("launch_transition_conflict", 409,
          `Invalid Agent Launch transition ${String(current.state)} -> ${target}`);
      }
      // The daemon's report time may trail the Hub clock that created the
      // Launch and its Run; evidence keeps it, row clocks never move backward.
      const at = text(input.at, "at", 100);
      const errorMessage = input.errorMessage?.trim().slice(0, 2_000) || null;
      const updated = await tx.query<QueryResultRow>({ name: "runtime_agent_launch_update_v2", text: `UPDATE
        data.agent_launches SET state=$2,error_stage=$3,error_code=$4,error_message=$5,
          daemon_offline=CASE WHEN $2 IN ('admitted','spawned','connected') THEN FALSE ELSE daemon_offline END,
          retryable=$6,next_attempt_at=CASE WHEN $6 THEN $7::timestamptz ELSE next_attempt_at END,
          admitted_at=CASE WHEN $2='admitted' THEN COALESCE(admitted_at,$7) ELSE admitted_at END,
          spawned_at=CASE WHEN $2='spawned' THEN COALESCE(spawned_at,$7) ELSE spawned_at END,
          connected_at=CASE WHEN $2='connected' THEN COALESCE(connected_at,$7) ELSE connected_at END,
          last_reconciled_at=$7,
          version=version+1,updated_at=GREATEST(updated_at,$7::timestamptz),
          finished_at=CASE WHEN $2 IN ('connected','failed','cancelled')
            THEN $7 ELSE NULL END WHERE launch_id=$1 RETURNING *`, values: [launchId, target,
        input.errorStage || null, input.errorCode || null, errorMessage, input.retryable === true, at], maxRows: 1 });
      if (target === "failed" && input.retryable !== true && current.run_id) await tx.query({
        name: "runtime_agent_launch_fail_run_v2", text: `UPDATE data.runs SET status='failed',
          version=version+1,updated_at=GREATEST(updated_at,$2::timestamptz),finished_at=$2
          WHERE run_id=$1 AND status='starting'`,
        values: [current.run_id, at], maxRows: 0,
      });
      return { launch: serializeAgentLaunch({ ...updated[0], target_name: current.target_name,
        target_runtime: current.target_runtime }) };
    });
  }

  async retryAgentLaunch(input: { requestId: string; launchId: string; channelId: string; actorUserId: string;
    at: string }): Promise<{ launch: SerializedAgentLaunch }> {
    const { requestId, launchId, channelId } = launchRequest(input);
    const placement = await this.channelPlacement(requestId, channelId,
      "runtime.agent-launch.retry.locate", "runtime.agent-launch.retry.placement");
    return this.spaces.transaction(requestId, "runtime.agent-launch.retry", placement, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "runtime_agent_launch_retry_lock_v3", text: `SELECT
        launch.*,launch.spawn_payload_json->>'agentName' AS target_name,
        launch.spawn_payload_json->>'runtime' AS target_runtime,run.status AS run_status
        FROM data.agent_launches launch
        JOIN data.runs run ON run.run_id=launch.run_id
        WHERE launch.launch_id=$1 FOR UPDATE OF launch`, values: [launchId], maxRows: 1 });
      const current = rows[0];
      if (!current) throw new RuntimeControlError("not_found", 404, "Agent Launch not found");
      if (current.channel_id !== channelId) throw new RuntimeControlError("not_found", 404, "Agent Launch not found");
      await runtimeChannelCapability(tx, channelId, text(input.actorUserId, "actorUserId", 300),
        "runtime_new_work");
      if (current.state !== "failed" || current.retryable !== true || current.run_status !== "starting" ||
          !new Set(["launch_prepare", "directory_publish", "command_issue", "reverse_wake",
            "daemon_claim", "daemon_admit", "daemon_spawn"]).has(String(current.error_stage))) {
        throw new RuntimeControlError("launch_retry_conflict", 409,
          "This Launch may have produced a physical side effect; summon again instead");
      }
      const at = text(input.at, "at", 100);
      const nextAttempt = Number(current.attempt) + 1;
      const retryControlId = `launch-retry:${(await digest([launchId, nextAttempt])).slice(0, 40)}`;
      const retryPayload = { ...metadata(current, "spawn_payload_json"), requestId: retryControlId,
        launchId };
      const updated = await tx.query<QueryResultRow>({ name: "runtime_agent_launch_retry_v1", text: `UPDATE
        data.agent_launches SET state='prepared',attempt=attempt+1,next_attempt_at=$2,
          control_id=$3,spawn_payload_json=$4::jsonb,
          daemon_offline=FALSE,
          error_stage=NULL,error_code=NULL,error_message=NULL,retryable=FALSE,version=version+1,
          command_durable_at=NULL,wake_requested_at=NULL,admitted_at=NULL,spawned_at=NULL,
          last_reconciled_at=$2,updated_at=$2,finished_at=NULL WHERE launch_id=$1 RETURNING *`,
      values: [launchId, at, retryControlId, JSON.stringify(retryPayload)], maxRows: 1 });
      return { launch: serializeAgentLaunch({ ...updated[0], target_name: current.target_name,
        target_runtime: current.target_runtime }) };
    });
  }

  async recordAgentLaunchFirstReply(input: { requestId: string; channelId: string; runId: string;
    actorUserId: string; at: string }): Promise<{ recorded: boolean; launchAgeMs?: number }> {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId", 300);
    const route = await this.channelDirectory.resolve(
      { requestId, operation: "runtime.agent-launch.first-reply.locate" }, channelId);
    if (!route) return { recorded: false };
    const placement = await this.spaces.resolve(requestId, "runtime.agent-launch.first-reply.placement", route.spaceId);
    return this.spaces.transaction(requestId, "runtime.agent-launch.first-reply", placement, async (tx) => {
      await runtimeChannelCapability(tx, channelId, text(input.actorUserId, "actorUserId", 300),
        "runtime_terminalize");
      const rows = await tx.query<QueryResultRow>({ name: "runtime_agent_launch_first_reply_v1", text: `UPDATE
        data.agent_launches SET first_reply_at=$3,updated_at=GREATEST(updated_at,$3),version=version+1
        WHERE channel_id=$1 AND run_id=$2 AND state='connected' AND first_reply_at IS NULL
        RETURNING EXTRACT(EPOCH FROM ($3::timestamptz-created_at))*1000 AS launch_age_ms`,
      values: [channelId, text(input.runId, "runId", 300), text(input.at, "at", 100)], maxRows: 1 });
      return rows[0] ? { recorded: true, launchAgeMs: Math.max(0, Number(rows[0].launch_age_ms)) }
        : { recorded: false };
    });
  }

  async getChannelAgentRebornTarget(input: { requestId: string; channelId: string;
    agentName: string; channelInstanceId: number; actorUserId: string }) {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId", 300);
    const agentName = text(input.agentName, "agentName", 128);
    const channelInstanceId = integer(input.channelInstanceId, "channelInstanceId", 1);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const placement = await this.channelPlacement(requestId, channelId,
      "runtime.reborn-target.locate", "runtime.reborn-target.placement");
    return this.spaces.transaction(requestId, "runtime.reborn-target", placement, async (tx) => {
      await runtimeChannelCapability(tx, channelId, actorUserId, "runtime_new_work");
      // An Instance is found by its Space registration's display name or
      // harness at its Channel slot.
      const rows = await tx.query<QueryResultRow>({ name: "runtime_reborn_target_v4", text: `SELECT
          i.instance_id,i.status AS instance_status,i.channel_instance_id,
          r.run_id,r.owner_user_id,r.workspace_machine_id,
          r.workspace_canonical_cwd,r.metadata_json,r.status AS run_status,sr.display_name AS agent_name,
          sr.harness
        FROM data.instances i
        JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
        JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=$2
        JOIN data.space_agent_registrations sr ON sr.space_id=b.space_id AND sr.owner_user_id=b.owner_user_id
          AND sr.machine_id=b.machine_id AND sr.harness=b.harness
        WHERE i.channel_id=$1 AND i.channel_instance_id=$3
          AND (lower(sr.display_name)=$4 OR sr.harness=$4)
          AND COALESCE(r.metadata_json->>'routedAs','')<>'management_channel_about'
        LIMIT 2`, values: [channelId, placement.spaceId,
        channelInstanceId, normalizedAgentName(agentName)], maxRows: 2 });
      if (rows.length > 1) throw new RuntimeControlError(
        "ambiguous_agent_name", 409, "Select an Agent by owner and machine to identify this Instance");
      const row = rows[0];
      if (!row) throw new RuntimeControlError(
        "instance_not_found", 404, "Agent Instance not found in channel");
      const runMetadata = metadata(row);
      if (runMetadata.instanceDeletion !== undefined) throw new RuntimeControlError(
        "instance_not_found", 404, "Agent Instance was deleted or is being deleted");
      if (runMetadata.instanceHandoff !== undefined) throw new RuntimeControlError(
        "instance_not_found", 404, "Agent Instance was already handed off");
      return { target: {
        instanceId: String(row.instance_id), instanceStatus: String(row.instance_status), channelId,
        channelInstanceId: Number(row.channel_instance_id), runId: String(row.run_id),
        runStatus: String(row.run_status), agentName: String(row.agent_name), harness: String(row.harness),
        ownerUserId: String(row.owner_user_id),
        ...(row.workspace_machine_id && row.workspace_canonical_cwd ? { workspace: {
          machineId: String(row.workspace_machine_id),
          canonicalCwd: String(row.workspace_canonical_cwd),
        } } : {}), metadata: runMetadata,
      } };
    });
  }

  async listChannelAgentKillTargets(input: { requestId: string; channelId: string;
    actorUserId: string; cursor?: string | null; limit?: number;
    handoffSource?: { instanceId: string; runId: string } }) {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId", 300);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const limit = integer(input.limit ?? 200, "limit", 1);
    if (limit > 200) throw new RuntimeControlError(
      "invalid_runtime_request", 400, "limit is invalid");
    const cursor = runtimeInstanceCursor(input.cursor);
    const handoffInstanceId = input.handoffSource ? text(input.handoffSource.instanceId, "instanceId", 300) : null;
    const handoffRunId = input.handoffSource ? text(input.handoffSource.runId, "runId", 300) : null;
    const placement = await this.channelPlacement(requestId, channelId,
      "runtime.kill-targets.locate", "runtime.kill-targets.placement");
    return this.spaces.transaction(requestId, "runtime.kill-targets", placement, async (tx) => {
      await runtimeChannelCapability(tx, channelId, actorUserId, "runtime_terminalize");
      // A registered Run is identified by its Space registration and its Instance.
      const rows = await tx.query<QueryResultRow>({ name: "runtime_kill_targets_v6", text: `SELECT * FROM (
          SELECT i.instance_id,i.run_id,i.channel_instance_id,r.owner_user_id,
            r.metadata_json,b.owner_user_id AS machine_owner_user_id,sr.display_name AS agent_name,
            r.status AS run_status,i.status AS instance_status
          FROM data.instances i
          JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
          JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=$2
          JOIN data.space_agent_registrations sr ON sr.space_id=b.space_id AND sr.owner_user_id=b.owner_user_id
            AND sr.machine_id=b.machine_id AND sr.harness=b.harness
          WHERE i.channel_id=$1) target
        WHERE (($6::text IS NOT NULL AND target.instance_id=$6 AND target.run_id=$7::text)
          OR ($6::text IS NULL AND target.run_status IN (${ACTIVE_RUN_STATUS_SQL})
          AND (target.instance_status<>'offline' OR target.run_status IN ('starting','running')
            OR target.metadata_json ? 'stopRequest')))
          AND COALESCE(target.metadata_json->>'routedAs','')<>'management_channel_about'
          AND ($3::bigint IS NULL OR (target.channel_instance_id,target.instance_id)>($3::bigint,$4::text))
        ORDER BY target.channel_instance_id,target.instance_id LIMIT $5`, values: [channelId, placement.spaceId,
        cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1, handoffInstanceId, handoffRunId], maxRows: limit + 1 });
      const page = rows.slice(0, limit);
      return {
        targets: page.map((row) => {
          const runMetadata = metadata(row);
          const routedAs = typeof runMetadata.routedAs === "string" ? runMetadata.routedAs : undefined;
          const stopRequest = runMetadata.stopRequest && typeof runMetadata.stopRequest === "object"
            ? runMetadata.stopRequest as Record<string, unknown> : undefined;
          return {
            instanceId: String(row.instance_id), runId: String(row.run_id),
            agentId: String(row.instance_id), agentName: String(row.agent_name),
            mentionTarget: `${String(row.agent_name)}:${Number(row.channel_instance_id)}`,
            ownerUserId: String(row.owner_user_id),
            machineOwnerUserId: String(row.machine_owner_user_id),
            machineId: typeof runMetadata.machineId === "string" ? runMetadata.machineId : "",
            hostId: typeof runMetadata.hostname === "string" ? runMetadata.hostname :
              typeof runMetadata.hostId === "string" ? runMetadata.hostId : "",
            ...(typeof runMetadata.executionKey === "string"
              ? { executionKey: runMetadata.executionKey } : {}),
            ...(input.handoffSource ? { resumeSessionKey: runMetadata.resumeSessionKey,
              repoPool: runMetadata.repoPool } : {}),
            ...(routedAs ? { routedAs } : {}),
            ...(typeof stopRequest?.sourceMessageId === "string"
              ? { stopRequestSourceMessageId: stopRequest.sourceMessageId } : {}),
          };
        }),
        cursor: rows.length > limit && page.at(-1)
          ? JSON.stringify([Number(page.at(-1)!.channel_instance_id), String(page.at(-1)!.instance_id)])
          : null,
      };
    });
  }

  /**
   * Stop resting Instances (docs/instance-sleep.md §4). They have no process to
   * terminate, so a stop only records that the next message must not wake
   * them. `mention` selects `name:ordinal`; omitting it stops every resting
   * Instance in the Channel. Instances in `exclude` are live stop targets the
   * caller stops through the daemon instead.
   */
  async stopRestingInstances(input: { requestId: string; channelId: string; actorUserId: string;
    mention?: string; exclude?: readonly string[]; handoffSource?: { instanceId: string; runId: string } }) {
    const requestId = text(input.requestId, "requestId", 200);
    const channelId = text(input.channelId, "channelId", 300);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const mention = input.mention === undefined ? null : text(input.mention, "mention", 300).toLowerCase();
    const exclude = [...new Set(input.exclude ?? [])].map((value) => text(value, "exclude", 300));
    const handoffInstanceId = input.handoffSource ? text(input.handoffSource.instanceId, "instanceId", 300) : null;
    const handoffRunId = input.handoffSource ? text(input.handoffSource.runId, "runId", 300) : null;
    if (exclude.length > 1_000) throw new RuntimeControlError("invalid_runtime_request", 400, "exclude is invalid");
    const placement = await this.channelPlacement(requestId, channelId,
      "runtime.resting-stop.locate", "runtime.resting-stop.placement");
    return this.spaces.transaction(requestId, "runtime.resting-stop", placement, async (tx) => {
      await runtimeChannelCapability(tx, channelId, actorUserId, "runtime_terminalize");
      if (handoffInstanceId) {
        // Serialize with continuation preparation: a wake already in progress
        // cannot be left behind when this handoff starts somewhere else.
        await tx.query({ name: "runtime_handoff_rest_stop_lock_v1",
          text: "SELECT pg_advisory_xact_lock(hashtextextended('runtime-instance:'||$1,0))",
          values: [channelId], maxRows: 1 });
        const source = await tx.query({ name: "runtime_handoff_rest_stop_source_v1", text: `SELECT instance_id
          FROM data.instances WHERE instance_id=$1 AND run_id=$2 AND channel_id=$3 FOR UPDATE`,
          values: [handoffInstanceId, handoffRunId, channelId], maxRows: 1 });
        if (!source.length) throw new RuntimeControlError("reborn_source_changed", 409, "Handoff source was replaced");
        const pending = await tx.query({ name: "runtime_handoff_rest_stop_pending_v1", text: `SELECT intent_id
          FROM data.agent_reborn_intents WHERE source_instance_id=$1 AND channel_id=$2
            AND state IN ('waiting','prepared') LIMIT 1`, values: [handoffInstanceId, channelId], maxRows: 1 });
        if (pending.length) throw new RuntimeControlError("reborn_pending", 409, "Handoff source is already continuing");
      }
      const rows = await tx.query<QueryResultRow>({ name: "runtime_resting_stop_v2", text: `WITH target AS (
          SELECT i.instance_id,i.channel_instance_id,sr.display_name AS agent_name
          FROM data.instances i
          JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
          JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=$2
          JOIN data.space_agent_registrations sr ON sr.space_id=b.space_id AND sr.owner_user_id=b.owner_user_id
            AND sr.machine_id=b.machine_id AND sr.harness=b.harness
          WHERE i.channel_id=$1 AND i.status='offline' AND i.rest_state IN ('sleeping','interrupted','wake_failed')
            AND NOT (i.instance_id=ANY($4::text[]))
            AND ($3::text IS NULL OR lower(sr.display_name||':'||i.channel_instance_id::text)=$3)
            AND ($6::text IS NULL OR (i.instance_id=$6 AND i.run_id=$7::text))
          ORDER BY i.channel_instance_id,i.instance_id LIMIT 1000 FOR UPDATE OF i)
        UPDATE data.instances i SET rest_state='stopped',version=i.version+1,updated_at=GREATEST(i.updated_at,$5)
        FROM target WHERE i.instance_id=target.instance_id
        RETURNING i.instance_id,target.channel_instance_id,target.agent_name`,
      values: [channelId, placement.spaceId, mention, exclude, new Date().toISOString(), handoffInstanceId, handoffRunId], maxRows: 1_000 });
      return { stopped: rows.map((row) => ({ instanceId: String(row.instance_id),
        mentionTarget: `${String(row.agent_name)}:${Number(row.channel_instance_id)}` })) };
    });
  }

  async getRun(input: { requestId: string; runId: string; actorUserId: string; requireExecutionAccess?: boolean }) {
    const requestId = text(input.requestId, "requestId", 200);
    const runId = text(input.runId, "runId", 300);
    const route = await this.entityDirectory.resolve(
      { requestId, operation: "runtime.get-run.locate" }, "run", runId,
    );
    const placement = route ? await this.spaces.resolve(requestId, "runtime.get-run.placement", route.spaceId) : null;
    return this.database.transaction(placement ? { requestId, operation: "runtime.get-run",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } } : { requestId, operation: "runtime.get-run-legacy" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "runtime_get_run_v1", text: `SELECT r.*,
        i.instance_id,i.status AS instance_status,i.version AS instance_version,
        i.channel_instance_id AS instance_channel_instance_id FROM data.runs r
        LEFT JOIN data.instances i ON i.run_id=r.run_id
        WHERE r.run_id=$1 AND r.owner_user_id=$2 LIMIT 1`, values: [runId,
      text(input.actorUserId, "actorUserId", 300)], maxRows: 1 });
      if (!rows[0]) throw new RuntimeControlError("not_found", 404, "Run not found");
      let registrationAdmission;
      if (input.requireExecutionAccess) {
        if (!["starting", "running"].includes(String(rows[0].status))) throw new RuntimeControlError(
          "registration_run_terminal", 403, "This Run no longer accepts execution authority");
        registrationAdmission = await requireRunRegistrationAccess(tx, { runId, channelId: String(rows[0].channel_id),
          phase: rows[0].status === "starting" ? "admission" : "continuation",
          error: (code, status) => new RuntimeControlError(code, status, "Registration no longer authorizes this Run") });
      }
      return { run: serializePostgresRun(rows[0]), ...(registrationAdmission ? { registrationAdmission } : {}) };
    });
  }

  async getInstance(input: { requestId: string; instanceId: string; actorUserId: string }) {
    const requestId = text(input.requestId, "requestId", 200);
    const instanceId = text(input.instanceId, "instanceId", 300);
    const route = await this.entityDirectory.resolve(
      { requestId, operation: "runtime.get-instance.locate" }, "instance", instanceId,
    );
    const placement = route
      ? await this.spaces.resolve(requestId, "runtime.get-instance.placement", route.spaceId) : null;
    return this.database.transaction(placement ? { requestId, operation: "runtime.get-instance",
      placement: { spaceId: placement.spaceId, shardId: placement.shardId,
        placementEpoch: placement.placementEpoch } } : { requestId, operation: "runtime.get-instance-legacy" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "runtime_get_instance_v2", text: `SELECT i.*,
        r.workspace_machine_id,r.workspace_canonical_cwd,r.status AS run_status,
        r.metadata_json AS run_metadata_json FROM data.instances i JOIN data.runs r ON r.run_id=i.run_id
        WHERE i.instance_id=$1 AND r.owner_user_id=$2 LIMIT 1`, values: [instanceId,
      text(input.actorUserId, "actorUserId", 300)], maxRows: 1 });
      if (!rows[0]) throw new RuntimeControlError("not_found", 404, "Instance not found");
      return { instance: serializedInstance(rows[0]) };
    });
  }
}

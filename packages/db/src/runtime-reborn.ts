import { isActiveRunStatus, isTerminalRunStatus, parseNaturalRunId } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { naturalInstanceOrdinal } from "./natural-keys.js";
import { RuntimeControlError } from "./runtime-control.js";
import { readContinuationSource } from "./runtime-continuation-source.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeControlError(
    "invalid_runtime_request", 400, "Reborn payload is invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300) throw new RuntimeControlError(
    "invalid_runtime_request", 400, "Reborn identity is invalid");
  return value;
}
function sourceMachineScope(previous: QueryResultRow) {
  const before = object(previous.metadata_json);
  const observation = before.hostname ?? before.hostId;
  return { before, machineId: text(before.machineId), hostId: typeof observation === "string" ? observation : "" };
}
type ContinuationKind = "reborn" | "handoff" | "wake";

function cancellationIdentity(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  const cancellation = object(value);
  // Cleanup progress is mutable evidence, not a new cancellation request.
  return { reason: cancellation.reason, requestedAt: cancellation.requestedAt };
}
function rejectFenced(metadata: Record<string, unknown>): void {
  if (metadata.instanceDeletion !== undefined || metadata.instanceHandoff !== undefined) throw new RuntimeControlError(
    "reborn_source_fenced", 409, "Reborn predecessor was deleted, transferred or cancelled");
}
async function source(tx: DatabaseTransaction, instanceId: string): Promise<QueryResultRow> {
  const row = (await tx.query<QueryResultRow>({ name: "reborn_source_lock_v2", text: `SELECT
    instance.run_id,instance.channel_id,instance.channel_instance_id,instance.status AS instance_status,
    run.owner_user_id,run.status AS run_status,run.metadata_json,
    run.workspace_machine_id,run.workspace_canonical_cwd
    FROM data.instances instance JOIN data.runs run ON run.run_id=instance.run_id
    WHERE instance.instance_id=$1 FOR UPDATE OF instance,run`, values: [instanceId], maxRows: 1 }))[0];
  if (!row) throw new RuntimeControlError("not_found", 404, "Reborn predecessor not found");
  rejectFenced(object(row.metadata_json));
  return row;
}

function sameWorkspace(previous: QueryResultRow, run: Record<string, unknown>, spawn: Record<string, unknown>): boolean {
  const workspace = object(spawn.workspace);
  if (previous.workspace_machine_id && previous.workspace_canonical_cwd) {
    const next = run.workspace ? object(run.workspace) : undefined;
    return workspace.machineId === previous.workspace_machine_id &&
      workspace.canonicalCwd === previous.workspace_canonical_cwd &&
      next?.machineId === previous.workspace_machine_id && next?.canonicalCwd === previous.workspace_canonical_cwd;
  }
  // Managed trees have no registered Workspace row. Their original durable
  // materialization key, not a newly selected directory, is the resume binding.
  const key = object(previous.metadata_json).managedWorkspaceKey;
  return typeof key === "string" && key.length > 0 && workspace.managedKey === key &&
    object(run.metadata).managedWorkspaceKey === key && run.workspace === undefined;
}

/** The successor's Run, Instance and spawn as the caller prepared them. */
function continuationParts(input: Record<string, unknown>) {
  const run = object(input.run), instance = object(input.instance), spawn = object(input.spawnPayload);
  const metadata = object(run.metadata);
  text(metadata.executionKey);
  return { run, instance, spawn, metadata, runId: text(run.runId), instanceId: text(instance.instanceId),
    channelId: text(input.channelId), sourceRunId: text(input.sourceRunId) };
}

/** The successor runs where its source ran: same Run, Channel, owner, Machine and directory. */
function sameSourceExecution(previous: QueryResultRow, successor: { sourceRunId: string; channelId: string;
  machineId: string; hostId: string; run: Record<string, unknown>; metadata: Record<string, unknown>;
  spawn: Record<string, unknown> }): boolean {
  const workspace = object(successor.spawn.workspace);
  return previous.run_id === successor.sourceRunId && previous.channel_id === successor.channelId &&
    successor.metadata.machineId === successor.machineId &&
    workspace.ownerUserId === previous.owner_user_id && workspace.machineId === successor.machineId &&
    sameWorkspace(previous, successor.run, successor.spawn);
}

/** A replay of the same continuation receives its recorded intent. */
async function existingIntent(tx: DatabaseTransaction, runId: string, actorUserId: string, sourceRunId: string,
  sourceInstanceId: string, instanceId: string): Promise<Record<string, unknown> | undefined> {
  const prior = (await tx.query<QueryResultRow>({ name: "continuation_intent_existing_v1", text: `SELECT
    actor_user_id,source_run_id,source_instance_id,state FROM data.agent_reborn_intents WHERE intent_id=$1`,
    values: [runId], maxRows: 1 }))[0];
  if (!prior) return undefined;
  if (prior.actor_user_id !== actorUserId || prior.source_run_id !== sourceRunId ||
      prior.source_instance_id !== sourceInstanceId) throw new RuntimeControlError(
    "conflict", 409, "Continuation intent identity changed");
  return { entityId: instanceId, intentId: runId, state: prior.state, reused: true };
}

/** The durable intent: stop the predecessor (retaining its directory), then
 * create the successor. One continuation may be pending per source Instance.
 * A wake is a reborn no message asked for; its kind says where failure goes. */
async function recordIntent(tx: DatabaseTransaction, input: { kind: ContinuationKind; suffix: string; runId: string;
  spaceId: string; channelId: string; actorUserId: string; previous: QueryResultRow; before: Record<string, unknown>;
  sourceRunId: string; sourceInstanceId: string; machineId: string; hostId: string; run: Record<string, unknown>;
  instance: Record<string, unknown>; spawn: Record<string, unknown>; at: string }): Promise<Record<string, unknown>> {
  const { before, previous, sourceInstanceId } = input;
  const pending = await tx.query({ name: "continuation_source_pending_v1", text: `SELECT intent_id
    FROM data.agent_reborn_intents WHERE source_instance_id=$1 AND state IN ('waiting','prepared') LIMIT 1`,
    values: [sourceInstanceId], maxRows: 1 });
  if (pending.length) throw new RuntimeControlError("reborn_pending", 409, "This Instance already has a pending continuation");
  const stopControlId = `${input.kind}:0-stop:${input.suffix}`;
  const stopRequired = isActiveRunStatus(previous.run_status) ||
    ["online", "busy", "idle"].includes(String(previous.instance_status));
  const stopPayload = { type: "machine_stop_agent", requestId: stopControlId, runId: input.sourceRunId,
    channelId: input.channelId, executionKey: text(before.executionKey), agentId: sourceInstanceId, instanceId: sourceInstanceId,
    ...(before.resumeSessionKey ? { resumeSessionKey: text(before.resumeSessionKey) } : {}),
    ...(input.kind !== "handoff" ? { preserveInstanceForReborn: true } : {}),
    worktreeDisposition: "retain", reason: input.kind === "handoff" ? "Handoff requested" : "Durable reborn requested" };
  await tx.query({ name: "continuation_intent_insert_v1", text: `INSERT INTO data.agent_reborn_intents
    (intent_id,space_id,channel_id,actor_user_id,owner_user_id,source_run_id,source_instance_id,
      successor_run_id,stop_control_id,machine_id,hostname,stop_required,stop_payload_json,
      run_input_json,instance_input_json,spawn_payload_json,source_cancellation_json,created_at,updated_at,expires_at,kind)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$1,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
      $16::jsonb,$17,$17,$17::timestamptz+interval '24 hours',$18)`,
    values: [input.runId, input.spaceId, input.channelId, input.actorUserId, previous.owner_user_id, input.sourceRunId,
      sourceInstanceId, stopControlId, input.machineId, input.hostId, stopRequired, JSON.stringify(stopPayload),
      JSON.stringify(input.run), JSON.stringify(input.instance), JSON.stringify(input.spawn),
      JSON.stringify(cancellationIdentity(before.executionCancellation)), input.at, input.kind], maxRows: 0 });
  return { entityId: String(input.instance.instanceId), intentId: input.runId, state: "waiting", reused: false };
}

/** Runs inside Runtime's authenticated Channel transaction, before any stop. */
export async function prepareReborn(tx: DatabaseTransaction, input: Record<string, unknown>,
  actorUserId: string, spaceId: string, at: string): Promise<Record<string, unknown>> {
  const { run, instance, spawn, metadata, runId, instanceId, channelId, sourceRunId } = continuationParts(input);
  const kind = input.kind === "wake" ? "wake" : "reborn";
  text(metadata.resumeSessionKey);
  // The spawn request carries the reborn key. The successor Run is either the
  // legacy id derived from it or the next natural Run of this Instance.
  const suffix = /^reborn:1-spawn:([a-f0-9]{64})$/u.exec(String(spawn.requestId))?.[1];
  const naturalRun = parseNaturalRunId(runId), instanceOrdinal = naturalInstanceOrdinal(channelId, instanceId);
  const successorRun = runId === `run:reborn:${suffix}` || (naturalRun !== null && !("about" in naturalRun) &&
    naturalRun.channelId === channelId && (instanceOrdinal === null || String(instanceOrdinal) === naturalRun.channelInstanceId));
  if (!suffix || !successorRun || instanceId !== input.sourceInstanceId || instance.runId !== runId ||
      run.channelId !== channelId || instance.channelId !== channelId || run.status !== "starting" ||
      instance.status !== "offline" || metadata.resumeInstanceId !== instanceId ||
      spawn.runId !== runId || spawn.instanceId !== instanceId || spawn.channelId !== channelId ||
      spawn.executionKey !== metadata.executionKey || spawn.identityId !== instanceId ||
      spawn.resumeInstanceId !== instanceId || spawn.resume !== true ||
      spawn.resumeSessionKey !== metadata.resumeSessionKey ||
      spawn.type !== "machine_spawn_agent" ||
      run.spaceId !== spaceId || instance.spaceId !== spaceId || spawn.spaceId !== spaceId) {
    throw new RuntimeControlError("invalid_runtime_request", 400, "Reborn successor binding is invalid");
  }
  // The intent is where a reborn's status is read from, from acceptance on;
  // its source must name exactly this predecessor and message. A wake has none.
  if (kind === "wake" && run.invocationSource !== undefined) {
    throw new RuntimeControlError("invalid_runtime_request", 400, "A wake answers no message");
  }
  if (run.invocationSource !== undefined) {
    const continuation = readContinuationSource(run.invocationSource);
    if (!continuation || continuation.kind !== "reborn" || continuation.sourceInstanceId !== instanceId ||
        continuation.targetInstanceId !== instanceId || continuation.sourceRunId !== sourceRunId ||
        continuation.sourceMessageId !== metadata.sourceMessageId) {
      throw new RuntimeControlError("invalid_runtime_request", 400, "Reborn continuation source is invalid");
    }
  }
  const reused = await existingIntent(tx, runId, actorUserId, sourceRunId, instanceId, instanceId);
  if (reused) return reused;
  const previous = await source(tx, instanceId);
  const { before, machineId, hostId } = sourceMachineScope(previous);
  if (!sameSourceExecution(previous, { sourceRunId, channelId, machineId, hostId, run, metadata, spawn }) ||
      run.registration === undefined ||
      Number(previous.channel_instance_id) !== instance.channelInstanceId ||
      (before.resumeSessionKey !== undefined && (metadata.resumeSessionKey !== before.resumeSessionKey ||
        spawn.resumeSessionKey !== before.resumeSessionKey))) {
    throw new RuntimeControlError("reborn_source_changed", 409, "Reborn predecessor binding changed");
  }
  return recordIntent(tx, { kind, suffix, runId, spaceId, channelId, actorUserId, previous, before,
    sourceRunId, sourceInstanceId: instanceId, machineId, hostId, run, instance, spawn, at });

}

/**
 * A handoff is a continuation into a new Instance: the successor Run starts in
 * the predecessor's retained directory once the predecessor stopped. It uses
 * the same durable intent as a reborn; only the successor Instance differs.
 */
export async function prepareHandoff(tx: DatabaseTransaction, input: Record<string, unknown>,
  actorUserId: string, spaceId: string, at: string): Promise<Record<string, unknown>> {
  const { run, instance, spawn, metadata, runId, instanceId, channelId, sourceRunId } = continuationParts(input);
  const sourceInstanceId = text(input.sourceInstanceId);
  const suffix = /^handoff:1-spawn:([a-f0-9]{64})$/u.exec(String(spawn.requestId))?.[1];
  if (!suffix || run.handoff !== true || instanceId === sourceInstanceId || instance.runId !== runId ||
      run.channelId !== channelId || instance.channelId !== channelId || run.status !== "starting" ||
      instance.status !== "offline" || spawn.runId !== runId || spawn.instanceId !== instanceId ||
      spawn.channelId !== channelId || spawn.executionKey !== metadata.executionKey ||
      spawn.identityId !== instanceId || spawn.handoffTransfer !== true ||
      spawn.handoffSourceInstanceId !== sourceInstanceId || metadata.handoffSourceInstanceId !== sourceInstanceId ||
      spawn.type !== "machine_spawn_agent" ||
      run.spaceId !== spaceId || instance.spaceId !== spaceId || spawn.spaceId !== spaceId) {
    throw new RuntimeControlError("invalid_runtime_request", 400, "Handoff successor binding is invalid");
  }
  if (run.invocationSource !== undefined) {
    const continuation = readContinuationSource(run.invocationSource);
    if (!continuation || continuation.kind !== "handoff" || continuation.sourceInstanceId !== sourceInstanceId ||
        continuation.targetInstanceId !== instanceId || continuation.sourceRunId !== sourceRunId ||
        continuation.sourceMessageId !== metadata.sourceMessageId) {
      throw new RuntimeControlError("invalid_runtime_request", 400, "Handoff continuation source is invalid");
    }
  }
  const reused = await existingIntent(tx, runId, actorUserId, sourceRunId, sourceInstanceId, instanceId);
  if (reused) return reused;
  const previous = await source(tx, sourceInstanceId);
  const { before, machineId, hostId } = sourceMachineScope(previous);
  if (!sameSourceExecution(previous, { sourceRunId, channelId, machineId, hostId, run, metadata, spawn }) ||
      (before.resumeSessionKey !== undefined && spawn.handoffSourceResumeSessionKey !== before.resumeSessionKey)) {
    throw new RuntimeControlError("reborn_source_changed", 409, "Handoff source binding changed");
  }
  return recordIntent(tx, { kind: "handoff", suffix, runId, spaceId, channelId, actorUserId, previous, before,
    sourceRunId, sourceInstanceId, machineId, hostId, run, instance, spawn, at });

}

/** Creation and exact Instance rebind advance the durable spawn intent atomically. */
export async function advanceReborn(tx: DatabaseTransaction, input: Record<string, unknown>,
  actorUserId: string, spaceId: string, at: string,
  create: (run: Record<string, unknown>, instance: Record<string, unknown>) => Promise<void>,
): Promise<Record<string, unknown>> {
  const intentId = text(input.intentId);
  const row = (await tx.query<QueryResultRow>({ name: "reborn_intent_lock_v1", text: `SELECT *,expires_at>clock_timestamp() AS unexpired
    FROM data.agent_reborn_intents WHERE intent_id=$1 AND space_id=$2 FOR UPDATE`,
    values: [intentId, spaceId], maxRows: 1 }))[0];
  if (!row || row.actor_user_id !== actorUserId || row.channel_id !== input.channelId) {
    throw new RuntimeControlError("forbidden", 403, "Reborn intent is unavailable");
  }
  if (["waiting", "prepared"].includes(String(row.state)) && row.unexpired !== true) {
    throw new RuntimeControlError("reborn_expired", 409, "Reborn intent expired");
  }
  if (row.state === "prepared") {
    const current = await source(tx, String(row.source_instance_id));
    if (current.run_id !== row.successor_run_id || !["starting", "running"].includes(String(current.run_status)) ||
        object(current.metadata_json).executionCancellation !== undefined) throw new RuntimeControlError(
      "reborn_source_changed", 409, "Reborn successor was replaced or stopped");
    return { entityId: intentId, state: "prepared", deferred: true };
  }
  if (row.state !== "waiting") return { entityId: intentId, state: row.state, deferred: true };
  const previous = await source(tx, String(row.source_instance_id));
  if (previous.run_id !== row.source_run_id || previous.channel_id !== row.channel_id ||
      previous.owner_user_id !== row.owner_user_id) throw new RuntimeControlError(
    "reborn_source_changed", 409, "Reborn predecessor was replaced");
  const metadata = object(previous.metadata_json);
  const successor = object(row.run_input_json);
  const spawn = object(row.spawn_payload_json);
  // A handoff successor is a new Instance with its own session; a reborn
  // successor keeps the predecessor's Instance, slot and session.
  const handoff = successor.handoff === true;
  if (metadata.executionKey !== object(row.stop_payload_json).executionKey ||
      metadata.machineId !== row.machine_id ||
      !sameWorkspace(previous, successor, spawn) ||
      (!handoff && Number(previous.channel_instance_id) !== object(row.instance_input_json).channelInstanceId) ||
      (!handoff && metadata.resumeSessionKey !== undefined &&
        metadata.resumeSessionKey !== object(successor.metadata).resumeSessionKey)) {
    throw new RuntimeControlError("reborn_source_changed", 409, "Reborn predecessor execution changed");
  }
  if (JSON.stringify(cancellationIdentity(metadata.executionCancellation)) !== JSON.stringify(row.source_cancellation_json)) {
    throw new RuntimeControlError("reborn_source_fenced", 409, "Reborn predecessor was cancelled after preparation");
  }
  if (!isTerminalRunStatus(previous.run_status)) {
    return { entityId: intentId, state: "waiting", deferred: true };
  }
  if (row.stop_required) {
    const evidence = metadata.daemonStopEvidence === undefined ? undefined : object(metadata.daemonStopEvidence);
    const completedAt = Date.parse(String(evidence?.completedAt));
    if (!evidence || evidence.schemaVersion !== 1 || !Number.isFinite(completedAt) || evidence.kind !== "stop_succeeded" || evidence.runId !== row.source_run_id ||
        evidence.executionKey !== metadata.executionKey || evidence.machineId !== row.machine_id ||
        evidence.controlId !== row.stop_control_id) {
      return { entityId: intentId, state: "waiting", deferred: true };
    }
  }
  const run = object(row.run_input_json), instance = object(row.instance_input_json);
  // Re-check current grants/registration/workspace through the canonical creators.
  await create(run, instance);
  await tx.query({ name: "reborn_intent_prepared_v1", text: `UPDATE data.agent_reborn_intents
    SET state='prepared',updated_at=$2 WHERE intent_id=$1`, values: [intentId, at], maxRows: 0 });
  return { entityId: intentId, runId: row.successor_run_id, instanceId: String(instance.instanceId), state: "prepared" };
}

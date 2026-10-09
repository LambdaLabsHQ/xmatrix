import { storeScopedCommandReplay } from "./command-replay.js";
import { hostnameMetadata } from "./hostname-metadata.js";
import type { QueryResultRow } from "pg";
import {
  ACTIVE_RUN_STATUS_SQL, agentPresetById, harnessActionAvailable, HARNESS_ACTION_CLAIM_TTL_MS, HARNESS_LOGIN_ACTIONS, legacyMachineDaemonId, MACHINE_HARNESS_ACTION_CAPABILITY, MACHINE_HARNESS_CURSOR_LAUNCHER_CAPABILITY, MACHINE_HARNESS_LOGIN_CAPABILITY, MACHINE_HARNESS_RELEASE_CAPABILITY, MACHINE_HARNESS_UNINSTALL_CAPABILITY, machineResourceObservation,
  parseHarnessInventory, parseHarnessActionRequest, parseHarnessActionResult, parseRoutingQuotaProbeRequest, parseRoutingQuotaProbeResponse,
  MACHINE_WORKTREE_ACTION_CAPABILITY, parseWorktreeActionRequest, parseWorktreeActionResult, WORKTREE_ACTION_CLAIM_TTL_MS,
  stableMachineDaemonId,
  sha256Hex } from "@xmatrix/protocol";
import { commandDigest as digest, commandJson as stable } from "./command-digest.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import {
  channelCapabilityPredicate,
  requireChannelCapability,
  type ChannelCapabilityFailure,
} from "./channel-capability-policy.js";
import { ensureMachineName, requireMachineName } from "./machine-names.js";
import { recordRegistrationQuotaProbeResult } from "./agent-registration-quota-probe.js";
import { recordHarnessActionInventory } from "./machine-harness-actions.js";
import { recordMachineRunTerminalReport, type MachineRunTerminalEvent } from "./machine-run-terminal-reports.js";
import { commandFields } from "./command-fields.js";
import { ControlError } from "./control-error.js";

const ACTIONS = new Set(["enroll", "connect", "report", "unregister", "issue", "issue_batch", "claim",
  "renew", "complete", "retry", "failed-deliver", "migration_preflight", "migration_fence", "recover_connect",
  "activation_begin", "activation_prepare", "activation_advance"]);
const COMMAND_TYPES = new Set(["spawn", "stop", "cleanup", "request_resolve", "recover_reply", "quota_probe",
  "harness_action", "worktree_action"]);
const RESULT_TYPES: Record<string, string> = {
  spawn: "machine_spawn_result", stop: "machine_stop_result",
  recover_reply: "machine_recover_reply_result",
  quota_probe: "machine_quota_probe_result",
  harness_action: "machine_harness_action_result",
  worktree_action: "machine_worktree_action_result",
  cleanup: "machine_worktree_cleanup_result", request_resolve: "machine_request_resolve_result",
};
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const COMMAND_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/**
 * A connected daemon claims a command within a second of its wake and renews a
 * held lease every 15 s. Work left unclaimed, or a lease left lapsed, this long
 * is evidence the "online" route is not responding.
 */
const UNANSWERED_AFTER_MS = 60_000;
/** Only recent work counts, so one command that can never be claimed does not
 * mark a working machine as not responding for its whole lifetime. */
const UNANSWERED_WINDOW_MS = 30 * 60 * 1_000;
/**
 * A command handed to its daemon this many times, each time left to lapse
 * without a word, fails instead of going out again: the daemon takes it and
 * never reports, so another lease would be the same. Whoever issued it reads
 * the failure (2026-10-09: spawns a Workstation daemon never answered were
 * leased ~6,600 times each over three days, their Launches silently queued).
 */
const MAX_UNANSWERED_DELIVERIES = 10;
const UNANSWERED_FAILURE = `The machine was given this ${MAX_UNANSWERED_DELIVERIES} times and never answered, so it was not run`;
const MACHINE_ACTIVATION_RUN_LIMIT = 1_000;
const SNAPSHOT_ROUTE_WINDOW_MS = 15 * 60 * 1_000;
const ACTIVATION_TERMINAL_PHASES = new Set(["stable_granted", "aborted"]);
// A host-derived Machine has one daemon per owner; its host is an observation.
const HOST_DERIVED_MACHINE_ID = /^machine:[0-9a-f]{64}$/u;
/** The id an earlier CLI minted per config directory; it now only names a Machine awaiting adoption. */
const MINTED_MACHINE_ID = /^machine:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// A new connection from a renamed host moves the Machine to that host name.
const REHOST_ACTIONS = new Set(["enroll", "connect", "recover_connect"]);
// Owner-issued work follows the Machine to whichever host it last connected from.
// A Machine its owner removed admits no daemon until the owner logs in on it again.
const RETIRED_REFUSED_ACTIONS = new Set(["enroll", "connect", "recover_connect"]);
/** The daemon recognises this refusal and stops instead of retrying. */
export const MACHINE_RETIRED_MESSAGE =
  "This Machine was removed from its owner's xMatrix account. Run `xmatrix login` on it to add it back.";

export class MachineControlError extends ControlError {
  override name = "MachineControlError";
}

function channelCapabilityError(failure: ChannelCapabilityFailure): MachineControlError {
  return new MachineControlError(failure.code, failure.status, failure.message);
}

const { text, integer, object: record } = commandFields((field) =>
  new MachineControlError("invalid_machine_command", 400, `${field} is invalid`));

/** The status of a command, which must be exactly the operation the caller expects. */
function commandStatus(row: QueryResultRow, controlId: string, commandType: string,
  expected: Record<string, unknown>): Record<string, unknown> {
  const payload = row.payload_json as Record<string, unknown>;
  if (row.command_type !== commandType || Object.entries(expected)
    .some(([field, value]) => payload[field] !== value)) throw new MachineControlError(
    "forbidden", 403, "Machine command is not the exact requested operation");
  return { controlId, status: row.status === "pending" ? "queued" : row.status,
    ...(row.result_json && typeof row.result_json === "object"
      ? { result: row.result_json as Record<string, unknown> } : {}),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at as Date | string).toISOString() } : {}) };
}

/**
 * What a completed command tells its caller beyond the completion: a stop
 * issued for a reborn predecessor, and the lifecycle Channel the issued
 * command named when the result reports on the same Run.
 */
function completionFacts(commandType: string, issued: Record<string, unknown>,
  payload: Record<string, unknown>): { stopPurpose?: "reborn-predecessor"; issuedLifecycleChannelId?: string } {
  return {
    ...(commandType === "stop" && issued.preserveInstanceForReborn === true
      ? { stopPurpose: "reborn-predecessor" as const }
      : {}),
    ...(issued.runId === payload.runId && typeof issued.channelId === "string" && issued.channelId.trim()
      ? { issuedLifecycleChannelId: text(issued.channelId, "issued.channelId", 180) }
      : {}),
  };
}

function fullDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function activationRunIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MACHINE_ACTIVATION_RUN_LIMIT) throw new MachineControlError(
    "machine_activation_invalid", 400, `${field} exceeds the bounded Run set`);
  const result = value.map((entry) => text(entry, field, 200));
  if (new Set(result).size !== result.length) throw new MachineControlError(
    "machine_activation_invalid", 400, `${field} contains duplicate Run ids`);
  return result;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function activationReceipt(row: QueryResultRow, receiptId?: string): Record<string, unknown> {
  const expectedRunIds = Array.isArray(row.expected_run_ids_json)
    ? row.expected_run_ids_json.map(String) : [];
  const phase = String(row.phase);
  const id = receiptId ?? (phase === "activation_prepared" && row.prepared_receipt_id ||
    phase === "active_fenced" && row.active_fenced_receipt_id ||
    phase === "active" && row.active_receipt_id || `${phase}:${String(row.transaction_id)}`);
  return {
    transactionId: String(row.transaction_id), artifactSha256: String(row.artifact_sha256),
    connectionEpoch: Number(row.provisional_connection_epoch), phase, receiptId: String(id),
    ...(row.run_set_digest ? { runSetDigest: String(row.run_set_digest) } : {}),
    ...(phase === "recovering" ? {
      runSetDigest: String(row.expected_run_set_digest), expectedRunIds,
    } : {}),
    ...(row.prepared_receipt_id ? { preparedReceiptId: String(row.prepared_receipt_id) } : {}),
    ...(row.active_fenced_receipt_id
      ? { activeFencedReceiptId: String(row.active_fenced_receipt_id) } : {}),
    ...(row.active_receipt_id ? { activeReceiptId: String(row.active_receipt_id) } : {}),
  };
}

function daemon(row: QueryResultRow) {
  return { id: String(row.daemon_id), userId: String(row.owner_user_id), email: String(row.owner_email),
    name: row.display_name ? String(row.display_name) : `xmatrix-daemon-${String(row.hostname ?? "")}`,
    status: String(row.status), machineId: String(row.machine_id), hostId: String(row.hostname ?? ""),
    ...(row.hostname ? { hostName: String(row.hostname ?? "") } : {}),
    ...(row.hostname ? { hostname: String(row.hostname ?? "") } : {}),
    ...(row.machine_name ? { machineName: String(row.machine_name) } : {}),
    ...(row.parent_machine_id ? { parentMachineId: String(row.parent_machine_id) } : {}),
    ...(row.auto_assign === false ? { autoAssign: false } : {}),
    ...(row.active_runs != null ? { activeRuns: Number(row.active_runs) } : {}),
    ...(row.unanswered_since && row.status === "online"
      ? { unansweredSince: new Date(row.unanswered_since as Date | string).toISOString() } : {}),
    capabilities: Array.isArray(row.capabilities_json) ? row.capabilities_json : [],
    metadata: row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {},
    version: Number(row.version), connectedAt: new Date(row.created_at as Date).toISOString(),
    firstSeenAt: new Date(row.created_at as Date).toISOString(),
    lastSeenAt: new Date(row.updated_at as Date).toISOString() };
}

async function replay(tx: DatabaseTransaction, ownerUserId: string, commandId: string,
  requestDigest: string, tolerateDigestMismatch = false): Promise<Record<string, unknown> | null> {
  const rows = await tx.query<QueryResultRow>({ name: "machine_control_replay_read_v1", text: `SELECT
    request_digest,result_json FROM control.scoped_control_command_replays WHERE scope_kind='user'
    AND scope_id=$1 AND command_id=$2 AND command_kind='machine-daemon-control'
    AND expires_at>clock_timestamp() LIMIT 1`, values: [ownerUserId, commandId], maxRows: 1 });
  if (!rows[0]) return null;
  if (rows[0].request_digest !== requestDigest) {
    if (tolerateDigestMismatch) return null;
    throw new MachineControlError("idempotency_mismatch", 409, "Machine command id was reused");
  }
  return { ...(rows[0].result_json as Record<string, unknown>), reused: true };
}

async function storeReplay(tx: DatabaseTransaction, input: { ownerUserId: string; commandId: string;
  requestDigest: string; value: Record<string, unknown>; at: string }) {
  await storeScopedCommandReplay(tx, "machine_control_replay_write_v1", {
    scopeKind: "user", scopeId: input.ownerUserId, commandId: input.commandId,
    commandKind: "machine-daemon-control", requestDigest: input.requestDigest, result: input.value, at: input.at, ttlMs: REPLAY_TTL_MS,
  });
}

/**
 * A host-derived Machine has one canonical daemon. Enrollment used to rename
 * only when that row was missing; a later host rename can find the canonical
 * row and a legacy FNV row already sitting on the destination host. UNIQUE
 * (owner, machine, host) then rejects the rename. Fold the extras onto the
 * canonical id first. The destination host's own facts still win below.
 */
async function collapseSiblingDaemons(tx: DatabaseTransaction, ownerUserId: string, machineId: string, hostId: string) {
  if (!HOST_DERIVED_MACHINE_ID.test(machineId)) return;
  const canonicalId = stableMachineDaemonId(ownerUserId, machineId, hostId);
  const siblings = await tx.query<QueryResultRow>({ name: "machine_rehost_sibling_daemons_v1", text: `SELECT
    daemon_id FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2 AND daemon_id<>$3
    ORDER BY daemon_id FOR UPDATE`, values: [ownerUserId, machineId, canonicalId], maxRows: 20 });
  if (!siblings.length) return;
  const ids = siblings.map(row => String(row.daemon_id));
  // One activation per daemon. Keep the canonical receipt; otherwise keep the
  // newest sibling receipt and drop the rest before they share a primary key.
  await tx.query({ name: "machine_rehost_sibling_activation_drop_v1", text: `DELETE FROM
    data.machine_daemon_activations extra WHERE extra.daemon_id=ANY($1::text[]) AND (
      EXISTS (SELECT 1 FROM data.machine_daemon_activations WHERE daemon_id=$2)
      OR extra.daemon_id<>(SELECT daemon_id FROM data.machine_daemon_activations
        WHERE daemon_id=ANY($1::text[]) ORDER BY updated_at DESC, daemon_id LIMIT 1))`,
  values: [ids, canonicalId], maxRows: 0 });
  await tx.query({ name: "machine_rehost_sibling_activation_move_v1", text: `UPDATE
    data.machine_daemon_activations SET daemon_id=$2 WHERE daemon_id=ANY($1::text[])`,
  values: [ids, canonicalId], maxRows: 0 });
  await tx.query({ name: "machine_rehost_sibling_allocation_move_v1", text: `UPDATE
    control.registration_execution_allocations SET daemon_id=$2
    WHERE owner_user_id=$3 AND machine_id=$4 AND daemon_id=ANY($1::text[])`,
  values: [ids, canonicalId, ownerUserId, machineId], maxRows: 0 });
  await tx.query({ name: "machine_rehost_sibling_audit_move_v1", text: `UPDATE
    data.machine_daemon_control_audit SET daemon_id=$2
    WHERE owner_user_id=$3 AND daemon_id=ANY($1::text[])`,
  values: [ids, canonicalId, ownerUserId], maxRows: 0 });
  await tx.query({ name: "machine_rehost_sibling_daemon_drop_v1", text: `DELETE FROM data.machine_daemons
    WHERE owner_user_id=$2 AND machine_id=$3 AND daemon_id=ANY($1::text[])`,
  values: [ids, ownerUserId, machineId], maxRows: 0 });
}


function issuedHarnessAction(issued: Record<string, unknown>) {
  return parseHarnessActionRequest({ requestId: issued.requestId, presetId: issued.presetId, action: issued.action });
}

function validatePrincipal(principal: Record<string, unknown>, action: string, ownerUserId: string,
  machineId: string) {
  if (action === "issue" || action === "issue_batch" || action === "enroll" || action === "failed-deliver") {
    if (principal.kind !== "user" || principal.id !== ownerUserId) throw new MachineControlError(
      "forbidden", 403, "Machine command requires the exact Human owner");
    return;
  }
  if (principal.kind !== "machine" || principal.ownerUserId !== ownerUserId ||
      principal.machineId !== machineId ||
      (principal.id !== `machine-daemon:${ownerUserId}:${machineId}` &&
       principal.id !== `machine-daemon:${ownerUserId}:${machineId}:${principal.hostId}`)) throw new MachineControlError(
    "forbidden", 403, "Machine command requires the exact Machine principal");
}

function exactResult(commandType: string, issued: Record<string, unknown>, eventType: string,
  payload: Record<string, unknown>, controlId: string) {
  if (eventType !== RESULT_TYPES[commandType] || payload.requestId !== controlId) {
    throw new MachineControlError("machine_command_result_mismatch", 409,
      "Machine result does not match the leased command");
  }
  if (commandType === "quota_probe") {
    try {
      parseRoutingQuotaProbeResponse(payload.probe, parseRoutingQuotaProbeRequest(issued.probe), Date.now());
      if (Object.keys(payload).some(key => !["type", "requestId", "probe", "relayLease"].includes(key))) {
        throw new Error("Unexpected quota result field");
      }
    } catch {
      throw new MachineControlError("machine_command_result_mismatch", 409, "Quota result differs from the issued probe");
    }
  }
  if (commandType === "harness_action") {
    try {
      parseHarnessActionResult(payload.result, issuedHarnessAction(issued));
      if (Object.keys(payload).some(key => !["type", "requestId", "result", "relayLease"].includes(key))) {
        throw new Error("Unexpected harness result field");
      }
    } catch {
      throw new MachineControlError("machine_command_result_mismatch", 409, "Harness result differs from the issued action");
    }
  }
  if (commandType === "worktree_action") {
    try {
      parseWorktreeActionResult(payload.result, parseWorktreeActionRequest(issued));
      if (Object.keys(payload).some(key => !["type", "requestId", "result", "relayLease"].includes(key))) {
        throw new Error("Unexpected worktree result field");
      }
    } catch {
      throw new MachineControlError("machine_command_result_mismatch", 409, "Worktree result differs from the issued action");
    }
  }
  const identityFields = commandType === "spawn"
    ? ["launchId", "runId", "executionKey", "instanceId", "channelId", "agentName", "identityId"]
    : ["runId", "executionKey", "agentId", "instanceId", "resumeSessionKey",
        "daemonRequestId", "repoIdentity", "repoKeyId", "slotId", "worktreeDisposition"];
  if (commandType === "recover_reply") identityFields.push("channelId", "executionId");
  const recoveryResult = commandType === "recover_reply" && payload.result && typeof payload.result === "object"
    ? payload.result as Record<string, unknown> : undefined;
  if (commandType === "recover_reply" && (!recoveryResult ||
      recoveryResult.status === "committed" && issued.messageId !== undefined && recoveryResult.messageId !== issued.messageId)) {
    throw new MachineControlError("machine_command_result_mismatch", 409, "Recovery result differs from the selected reply");
  }
  if (identityFields.some((field) => issued[field] !== undefined && payload[field] !== issued[field])) {
    throw new MachineControlError("machine_command_result_mismatch", 409,
      "Machine result target differs from the issued command");
  }
}

export class PostgresMachineControlRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new MachineControlError(
      "cached_authority_forbidden", 500, "Machine command authority requires uncached PostgreSQL");
  }

  async command(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = text(input.commandId, "commandId", 200);
    const action = text(input.action, "action", 32);
    if (!ACTIONS.has(action)) throw new MachineControlError(
      "invalid_machine_command", 400, "Machine command action is invalid");
    const ownerUserId = text(input.ownerUserId, "ownerUserId", 200);
    const ownerEmail = text(input.ownerEmail, "ownerEmail", 320);
    const machineId = text(input.machineId, "machineId", 160);
    const observation = input.hostname ?? input.hostId;
    let hostId = observation === undefined || observation === "" ? "" : text(observation, "hostname", 160);
    const daemonId = text(input.daemonId, "daemonId", 700);
    const principal = record(input.principal, "principal");
    const hostDerived = HOST_DERIVED_MACHINE_ID.test(machineId);
    // Every supported CLI derives its Machine id from the host; a minted id is only
    // an adoption source and history, never a daemon that enrolls or connects.
    if (MINTED_MACHINE_ID.test(machineId) && ["enroll", "connect", "recover_connect"].includes(action)) {
      throw new MachineControlError("machine_id_upgrade_required", 426,
        "Update the xMatrix CLI: a Machine is identified by its host, not a minted id");
    }
    validatePrincipal(principal, action, ownerUserId, machineId);
    const connectionEpoch = ["enroll", "connect", "issue", "issue_batch", "failed-deliver", "recover_connect",
      "migration_preflight", "migration_fence"].includes(action)
      ? undefined : integer(input.connectionEpoch, "connectionEpoch", 1);
    const payload = record(input.payload, "payload");
    if (input.eventType === "machine_stop_result" && payload.cleanupReason !== undefined &&
        payload.cleanupReason !== "process_terminated" && payload.cleanupReason !== "already_absent") {
      throw new MachineControlError(
        "invalid_machine_command", 400, "Machine Daemon stop cleanup reason is invalid");
    }
    const at = new Date().toISOString();
    const requestDigest = await digest(input);
    return this.database.transaction({ requestId: commandId,
      operation: `machine-control.${action}` }, async (tx) => {
      await tx.query({ name: "machine_control_scope_lock_v2",
        text: "SELECT pg_advisory_xact_lock(hashtextextended('machine-control:'||$1||':'||$2,0))",
        values: [ownerUserId, machineId], maxRows: 1 });
      if (input.requireMachineName === true && ["enroll", "connect", "recover_connect"].includes(action)) {
        await requireMachineName(tx, { ownerUserId, machineId });
      }
      const deleted = await tx.query({ name: "machine_control_account_deleted_v1",
        text: "SELECT 1 FROM data.account_deletion_fences WHERE user_id=$1 AND committed", values: [ownerUserId], maxRows: 1 });
      if (deleted.length) throw new MachineControlError("machine_retired", 410, "The owner's account was deleted");
      if (RETIRED_REFUSED_ACTIONS.has(action)) {
        const retired = await tx.query<QueryResultRow>({ name: "machine_control_retired_v1", text: `SELECT 1
          FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2 AND retired_at IS NOT NULL`,
        values: [ownerUserId, machineId], maxRows: 1 });
        if (retired[0]) throw new MachineControlError("machine_retired", 410, MACHINE_RETIRED_MESSAGE);
      }
      const currentRows = await tx.query<QueryResultRow>({ name: "machine_control_daemon_lock_v1",
        text: "SELECT * FROM data.machine_daemons WHERE daemon_id=$1 FOR UPDATE",
        values: [daemonId], maxRows: 1 });
      let current: QueryResultRow | undefined = currentRows[0];
      if (!current && hostDerived && action === "enroll") {
        current = await this.recoverLegacyDaemonKey(tx, { ownerUserId, machineId, daemonId });
      }
      if (current && !hostId) hostId = String(current.hostname ?? "");
      if (current && hostDerived && current.owner_user_id === ownerUserId && current.machine_id === machineId &&
          current.hostname !== hostId) {
        if (REHOST_ACTIONS.has(action)) {
          await collapseSiblingDaemons(tx, ownerUserId, machineId, hostId);
          const observed = await tx.query<QueryResultRow>({ name: "machine_hostname_observe_v1",
            text: `UPDATE data.machine_daemons SET hostname=NULLIF($4,'')
              WHERE daemon_id=$1 AND owner_user_id=$2 AND machine_id=$3 RETURNING *`,
            values: [daemonId, ownerUserId, machineId, hostId], maxRows: 1 });
          if (!observed[0]) throw new MachineControlError("machine_identity_conflict", 409,
            "Machine observation requires its exact daemon scope");
          current = observed[0];
        } else {
          // Compatibility columns follow the current observation; only the epoch fences a process.
          hostId = String(current.hostname ?? "");
        }
      }
      if (current && (current.owner_user_id !== ownerUserId || current.machine_id !== machineId)) throw new MachineControlError(
        "machine_identity_conflict", 409, "Machine Daemon identity is already bound");
      if (action === "failed-deliver") {
        if (!current) return { delivered: 0, owners: 0, deliverable: false };
        current = await this.commitDaemon(tx, { action, current, daemonId, ownerUserId, ownerEmail,
          machineId, hostId, input, at });
        return {
          commandId, action, daemon: daemon(current),
          connectionEpoch: Number(current.connection_epoch),
          delivered: 0, owners: 0, deliverable: false,
        };
      }
      const existingEnrollmentRows = action === "enroll"
        ? await tx.query<QueryResultRow>({ name: "machine_control_enrollment_recovery_v1", text: `SELECT
          daemon_id,owner_user_id,action,event_type,created_at
          FROM data.machine_daemon_control_audit WHERE command_id=$1 LIMIT 1`,
        values: [commandId], maxRows: 1 })
        : [];
      const existingEnrollment = existingEnrollmentRows[0];
      if (existingEnrollment) {
        // Enrollment evidence outlives bounded command replays and was migrated
        // independently from D1. Recover the stable identity when that evidence
        // matches exactly instead of attempting to insert the historical key.
        if (current && existingEnrollment.daemon_id === daemonId &&
            existingEnrollment.owner_user_id === ownerUserId &&
            existingEnrollment.action === "enroll") {
          return { commandId, action, reused: true, daemon: daemon(current),
            connectionEpoch: Number(current.connection_epoch), audit: {
              commandId, action,
              ...(existingEnrollment.event_type
                ? { eventType: String(existingEnrollment.event_type) } : {}),
              at: new Date(existingEnrollment.created_at as Date).toISOString(),
              persisted: true, recovered: true,
            } };
        }
        throw new MachineControlError("idempotency_mismatch", 409,
          "Machine Daemon enrollment exists without its exact idempotency result");
      }
      if (!current && ["report", "claim", "renew", "complete", "retry", "unregister"].includes(action)) {
        throw new MachineControlError("machine_daemon_not_registered", 409,
          "Machine Daemon must connect before this operation");
      }
      if (!current && ["migration_preflight", "migration_fence", "recover_connect", "activation_begin",
        "activation_prepare", "activation_advance"].includes(action)) throw new MachineControlError(
        "machine_daemon_not_registered", 409, "Machine Daemon must enroll before activation");
      if (current && action === "connect") {
        const activation = await this.activation(tx, daemonId);
        if (activation && !ACTIVATION_TERMINAL_PHASES.has(String(activation.phase))) {
          throw new MachineControlError("machine_daemon_activation_in_progress", 409,
            "Machine Daemon connection cannot bypass an in-progress activation transaction");
        }
      }
      // A completion transaction may have committed immediately before its
      // response or socket ACK was lost. Its exact request replay is safe even
      // after a reconnect advanced the daemon epoch: no new physical effect is
      // authorized here, and the stored response lets the caller finish the
      // downstream Launch/Run reconciliation. A completion that was not
      // already committed still reaches the epoch and lease fences below.
      if (action === "complete") {
        const prior = await replay(tx, ownerUserId, commandId, requestDigest, true);
        if (prior) return prior;
      }
      if (current && connectionEpoch !== undefined &&
          !["activation_prepare", "activation_advance"].includes(action) &&
          Number(current.connection_epoch) !== connectionEpoch) {
        throw new MachineControlError("machine_daemon_stale_epoch", 409,
          "Machine Daemon process was replaced by a newer connection");
      }
      if (["migration_preflight", "migration_fence", "recover_connect", "activation_begin",
        "activation_prepare", "activation_advance"].includes(action)) return this.activationCommand(tx, {
        input, action, current: current!, daemonId, ownerUserId, machineId, hostId, commandId,
        connectionEpoch, payload, at,
      });
      if (action === "claim" && !await this.activationMayClaim(tx, daemonId, connectionEpoch!)) {
        throw new MachineControlError("machine_daemon_activation_fenced", 409,
          "Machine Daemon cannot claim commands before Supervisor StableGranted");
      }
      if (action !== "claim" && action !== "complete") {
        const prior = await replay(tx, ownerUserId, commandId, requestDigest);
        if (prior) return prior;
      }
      if (action === "claim") return this.claim(tx, input, current!, connectionEpoch!, at);
      if (action === "renew") return this.renew(tx, input, current!, connectionEpoch!, at);
      if (action === "issue") await this.issue(tx, input, ownerUserId, machineId, hostId, payload, at);
      const batchIssue = action === "issue_batch"
        ? await this.issueBatch(tx, input, ownerUserId, machineId, hostId, at) : undefined;
      // An older daemon still asks its owner to approve host commands. Nothing
      // decides those any more; it learns so at once instead of waiting.
      if (input.eventType === "machine_request_notice") throw new MachineControlError(
        "host_command_requests_retired", 410,
        "Host command approval is retired; update the xMatrix CLI on this machine");
      const completion = action === "complete"
        ? await this.complete(tx, input, ownerUserId, machineId, hostId, connectionEpoch!, payload, at)
        : undefined;
      if (action === "retry") await this.retry(tx, input, ownerUserId, machineId,
        connectionEpoch!);
      current = await this.commitDaemon(tx, { action, current, daemonId, ownerUserId, ownerEmail,
        machineId, hostId, input, at });
      if (action === "connect" || action === "report" && connectionEpoch !== undefined) {
        await tx.query({ name: "machine_routing_observation_v1", text: `UPDATE data.machine_daemons
          SET routing_observed_at=clock_timestamp() WHERE daemon_id=$1 AND status='online'
            AND connection_epoch=$2`, values: [daemonId, Number(current.connection_epoch)], maxRows: 0 });
      }
      if (action === "enroll") await tx.query({ name: "machine_control_enrollment_audit_v1", text: `INSERT INTO
        data.machine_daemon_control_audit
        (command_id,daemon_id,owner_user_id,action,event_type,payload_json,created_at)
        VALUES ($1,$2,$3,'enroll',$4,$5::jsonb,$6)`, values: [commandId, daemonId, ownerUserId,
      input.eventType ?? null, JSON.stringify({ target: { ownerUserId, machineId, hostId, daemonId } }), at], maxRows: 0 });
      let runLifecycleChannelId: string | undefined;
      let runLifecycleChannelIds: string[] = [];
      if (typeof payload.runId === "string" && payload.runId.trim()) {
        const routes = await tx.query<QueryResultRow>({ name: "machine_control_run_route_read_v2", text: `SELECT
          channel_id FROM data.machine_run_routes WHERE run_id=$1 AND owner_user_id=$2
          AND machine_id=$3 LIMIT 1`, values: [payload.runId, ownerUserId, machineId], maxRows: 1 });
        runLifecycleChannelId = routes[0]
          ? String(routes[0].channel_id)
          : completion?.issuedLifecycleChannelId;
      }
      if (action === "report" && input.eventType === "machine_run_snapshot") {
        // The daemon reports its resources when they change, not on a timer, so
        // an observation stays current for the connection that reported it.
        const resources = machineResourceObservation(payload.machineResources, Date.parse(at));
        if (resources) await tx.query({ name: "machine_resource_observation_v2", text: `UPDATE data.machine_daemons
          SET metadata_json=jsonb_set(metadata_json,'{machineResources}',$3::jsonb)
          WHERE daemon_id=$1 AND connection_epoch=$2 AND status='online'
            AND (metadata_json->'machineResources'->>'observedAt' IS NULL
              OR metadata_json->'machineResources'->>'connectionEpoch' IS DISTINCT FROM $2::text
              OR metadata_json->'machineResources'->>'observedAt' < $4)`,
          values: [daemonId, connectionEpoch, JSON.stringify({ ...resources, connectionEpoch }),
            resources.observedAt], maxRows: 0 });
        // History keeps one sample per Machine per minute: the latest one the live
        // connection reported in that minute.
        if (resources) await tx.query({ name: "machine_resource_history_sample_v1", text: `INSERT INTO
          data.machine_resource_samples (owner_user_id,machine_id,observed_at,cpu_usage_percent,
            load_average_1m,memory_total_bytes,memory_available_bytes,swap_total_bytes,swap_free_bytes,
            disk_total_bytes,disk_available_bytes)
          SELECT $1,$2,date_trunc('minute',$4::timestamptz),$5,$6,$7,$8,$9,$10,$11,$12
          WHERE EXISTS (SELECT 1 FROM data.machine_daemons WHERE daemon_id=$3 AND status='online'
            AND connection_epoch=$13)
          ON CONFLICT (owner_user_id,machine_id,observed_at) DO UPDATE SET
            cpu_usage_percent=EXCLUDED.cpu_usage_percent, load_average_1m=EXCLUDED.load_average_1m,
            memory_total_bytes=EXCLUDED.memory_total_bytes,
            memory_available_bytes=EXCLUDED.memory_available_bytes,
            swap_total_bytes=EXCLUDED.swap_total_bytes, swap_free_bytes=EXCLUDED.swap_free_bytes,
            disk_total_bytes=EXCLUDED.disk_total_bytes, disk_available_bytes=EXCLUDED.disk_available_bytes`,
          values: [ownerUserId, machineId, daemonId, resources.observedAt, resources.cpuUsagePercent ?? null,
            resources.loadAverage?.[0] ?? null, resources.memoryTotalBytes ?? null,
            resources.memoryAvailableBytes ?? null, resources.swapTotalBytes ?? null,
            resources.swapFreeBytes ?? null, resources.diskTotalBytes ?? null,
            resources.diskAvailableBytes ?? null, connectionEpoch], maxRows: 0 });

        // A harness inventory is an observation of the connection that sent it.
        // An invalid one is dropped rather than failing the Run snapshot it rides on.
        const harnesses = payload.harnessInventory === undefined ? undefined
          : parseHarnessInventory(payload.harnessInventory);
        if (harnesses) await tx.query({ name: "machine_harness_inventory_observation_v1", text: `UPDATE
          data.machine_daemons SET metadata_json=jsonb_set(metadata_json,'{harnesses}',$3::jsonb)
          WHERE daemon_id=$1 AND connection_epoch=$2 AND status='online'
            AND capabilities_json ? 'machine_harness_inventory_v1'
            AND (metadata_json->'harnesses'->>'capturedAt' IS NULL
              OR (metadata_json->'harnesses'->>'capturedAt')::timestamptz<$4::timestamptz)`,
          values: [daemonId, connectionEpoch, JSON.stringify(harnesses), harnesses.capturedAt], maxRows: 0 });

        runLifecycleChannelIds = await this.snapshotRoutes(tx, {
          ownerUserId, machineId, hostId, payload, at,
        });
      }
      if ((action === "report" || action === "complete") && typeof payload.runId === "string" &&
          (input.eventType === "machine_run_exited" ||
           input.eventType === "machine_stop_result" && payload.ok === true)) await tx.query({
        name: "machine_control_route_terminal_v2", text: `UPDATE data.machine_run_routes SET
          terminal_at=COALESCE(terminal_at,$1),updated_at=$1 WHERE run_id=$2 AND owner_user_id=$3
          AND machine_id=$4`, values: [at, payload.runId, ownerUserId, machineId],
        maxRows: 0 });
      // The report is acknowledged once this commits; the coordinator owns the
      // Run's lifecycle finalization from here, so the frame stays short.
      const terminalEvent = typeof payload.runId === "string" && runLifecycleChannelId &&
          (action === "report" || action === "complete") &&
          (input.eventType === "machine_run_exited" ||
            input.eventType === "machine_stop_result" && payload.ok === true)
        ? input.eventType as MachineRunTerminalEvent : undefined;
      if (terminalEvent) await recordMachineRunTerminalReport(tx, {
        runId: text(payload.runId, "payload.runId", 300), eventType: terminalEvent, ownerUserId,
        ownerEmail, machineId, hostId,
        ...(typeof input.hostName === "string" && input.hostName.trim()
          ? { hostName: input.hostName.trim().slice(0, 200) } : {}),
        channelId: runLifecycleChannelId!, connectionEpoch: Number(current!.connection_epoch),
        requestId: typeof payload.requestId === "string" && payload.requestId.trim()
          ? text(payload.requestId, "payload.requestId", 300) : commandId,
        payload, ...(completion?.stopPurpose === "reborn-predecessor"
          ? { stopPurpose: "reborn-predecessor" as const } : {}),
      });
      const value = { commandId, action, reused: completion?.reused === true, daemon: daemon(current),
        connectionEpoch: Number(current.connection_epoch),
        audit: { commandId, action, eventType: input.eventType ?? input.commandType, at,
          persisted: action === "enroll" }, ...(input.controlId ? { controlId: input.controlId } : {}),
        ...(batchIssue ? { commands: batchIssue } : {}),
        ...(runLifecycleChannelId ? { runLifecycleChannelId } : {}),
        ...(runLifecycleChannelIds.length ? { runLifecycleChannelIds } : {}),
        ...(terminalEvent ? { runTerminalReportRecorded: true } : {}),
        ...(completion?.stopPurpose
          ? { runLifecycleStopPurpose: completion.stopPurpose }
          : {}) };
      if (completion?.reused !== true) {
        await storeReplay(tx, { ownerUserId, commandId, requestDigest, value, at });
      }
      return value;
    });
  }

  /** Recover the pre-SHA daemon key without resetting connection or activation fences. */
  private async recoverLegacyDaemonKey(tx: DatabaseTransaction, input: {
    ownerUserId: string; machineId: string; daemonId: string;
  }): Promise<QueryResultRow | undefined> {
    const rows = await tx.query<QueryResultRow>({ name: "machine_control_legacy_key_lock_v1", text: `SELECT *
      FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
      ORDER BY daemon_id LIMIT 2 FOR UPDATE`, values: [input.ownerUserId, input.machineId], maxRows: 2 });
    if (!rows.length) return undefined;
    const row = rows[0]!;
    const legacyId = legacyMachineDaemonId(input.ownerUserId, input.machineId, String(row.hostname ?? ""));
    const canonicalId = stableMachineDaemonId(input.ownerUserId, input.machineId, String(row.hostname ?? ""));
    if (rows.length !== 1 || row.daemon_id !== legacyId || input.daemonId !== canonicalId) {
      throw new MachineControlError("machine_identity_conflict", 409,
        "Machine Daemon legacy key recovery requires one exact historical identity");
    }
    // The caller holds the owner/Machine advisory lock. Keep the epoch, status,
    // activation receipts and allocation bindings; the subsequent connect owns
    // advancing the epoch. A conflict aborts all changes in this transaction.
    const moved = await tx.query<QueryResultRow>({ name: "machine_control_legacy_key_move_v1", text: `UPDATE
      data.machine_daemons SET daemon_id=$2 WHERE daemon_id=$1 RETURNING *`,
    values: [legacyId, canonicalId], maxRows: 1 });
    await tx.query({ name: "machine_control_legacy_activation_move_v1", text: `UPDATE
      data.machine_daemon_activations SET daemon_id=$2 WHERE daemon_id=$1`,
    values: [legacyId, canonicalId], maxRows: 0 });
    await tx.query({ name: "machine_control_legacy_allocation_move_v1", text: `UPDATE
      control.registration_execution_allocations SET daemon_id=$2
      WHERE daemon_id=$1 AND owner_user_id=$3 AND machine_id=$4`,
    values: [legacyId, canonicalId, input.ownerUserId, input.machineId], maxRows: 0 });
    // Keep original payloads as historical evidence, but resolve enrollment
    // receipts to the migrated identity before the bounded replay lookup.
    await tx.query({ name: "machine_control_legacy_enrollment_move_v1", text: `UPDATE
      data.machine_daemon_control_audit SET daemon_id=$2 WHERE daemon_id=$1 AND owner_user_id=$3`,
    values: [legacyId, canonicalId, input.ownerUserId], maxRows: 0 });
    return moved[0];
  }

  private async activation(tx: DatabaseTransaction, daemonId: string): Promise<QueryResultRow | undefined> {
    return (await tx.query<QueryResultRow>({ name: "machine_activation_lock_v1", text: `SELECT *
      FROM data.machine_daemon_activations WHERE daemon_id=$1 FOR UPDATE`,
    values: [daemonId], maxRows: 1 }))[0];
  }

  private async activationMayClaim(
    tx: DatabaseTransaction,
    daemonId: string,
    connectionEpoch: number,
  ): Promise<boolean> {
    const row = await this.activation(tx, daemonId);
    if (!row || row.phase === "aborted") return true;
    return row.phase === "stable_granted" &&
      connectionEpoch >= Number(row.provisional_connection_epoch);
  }

  /**
   * Resolve the Channels a complete snapshot must reconcile, and record that
   * the reported Runs are still alive. A route is created per spawn and is only
   * terminalized by an exit report, so a host accumulates Channels whose Runs
   * ended without one. Fanning every snapshot out to all of them costs a
   * Channel authority round trip each, which delays the reports that follow.
   * Snapshot absence beyond the reconcile window is enough to stop paying for a
   * Channel; an offline host is instead reconciled by Supervisor activation.
   */
  private async snapshotRoutes(tx: DatabaseTransaction, input: {
    ownerUserId: string; machineId: string; hostId: string;
    payload: Record<string, unknown>; at: string;
  }): Promise<string[]> {
    const reportedRunIds = (Array.isArray(input.payload.runs) ? input.payload.runs : [])
      .flatMap((value) => {
        const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
        return typeof item.runId === "string" && item.runId.trim() ? [item.runId.trim()] : [];
      });
    // A partial snapshot carries only the Runs whose progress changed; it
    // reaches their Channels and never the reconcile window of a full one.
    if (input.payload.snapshotComplete !== true) {
      if (!reportedRunIds.length) return [];
      const touched = await tx.query<QueryResultRow>({ name: "machine_control_route_progress_v2",
        text: `UPDATE data.machine_run_routes SET updated_at=$1 WHERE owner_user_id=$2
          AND machine_id=$3 AND terminal_at IS NULL AND run_id=ANY($4::text[])
          RETURNING channel_id`,
        values: [input.at, input.ownerUserId, input.machineId, reportedRunIds],
        maxRows: MACHINE_ACTIVATION_RUN_LIMIT });
      return [...new Set(touched.map((row) => String(row.channel_id)))].sort();
    }
    const receivedMs = Date.parse(input.at);
    const capturedMs = Date.parse(String(input.payload.capturedAt));
    const reconcileFrom = new Date((Number.isFinite(capturedMs)
      ? Math.min(capturedMs, receivedMs) : receivedMs) - SNAPSHOT_ROUTE_WINDOW_MS).toISOString();
    if (reportedRunIds.length) await tx.query({ name: "machine_control_route_reported_v2",
      text: `UPDATE data.machine_run_routes SET updated_at=$1 WHERE owner_user_id=$2
        AND machine_id=$3 AND terminal_at IS NULL AND run_id=ANY($4::text[])`,
      values: [input.at, input.ownerUserId, input.machineId, reportedRunIds],
      maxRows: 0 });
    const routes = await tx.query<QueryResultRow>({ name: "machine_control_snapshot_routes_v3",
      text: `SELECT DISTINCT channel_id FROM data.machine_run_routes WHERE owner_user_id=$1
        AND machine_id=$2 AND terminal_at IS NULL
        AND (run_id=ANY($3::text[]) OR updated_at>$4) ORDER BY channel_id LIMIT 1001`,
    values: [input.ownerUserId, input.machineId, reportedRunIds, reconcileFrom],
    maxRows: 1001 });
    if (routes.length > 1_000) throw new MachineControlError("machine_run_route_capacity", 409,
      "Machine Run route fanout exceeds its bounded capacity");
    return routes.map((row) => String(row.channel_id));
  }

  private async liveRunIds(tx: DatabaseTransaction, input: {
    ownerUserId: string; machineId: string; hostId: string;
  }): Promise<string[]> {
    const rows = await tx.query<QueryResultRow>({ name: "machine_activation_live_runs_v2", text: `SELECT
      run_id FROM data.machine_run_routes WHERE owner_user_id=$1 AND machine_id=$2
      AND terminal_at IS NULL ORDER BY run_id LIMIT $3`, values: [input.ownerUserId, input.machineId, MACHINE_ACTIVATION_RUN_LIMIT + 1],
    maxRows: MACHINE_ACTIVATION_RUN_LIMIT + 1 });
    if (rows.length > MACHINE_ACTIVATION_RUN_LIMIT) throw new MachineControlError(
      "machine_activation_run_capacity", 409,
      "Machine Daemon activation exceeds the bounded live Run capacity");
    return rows.map((row) => String(row.run_id));
  }

  private async beginActivation(tx: DatabaseTransaction, input: {
    daemon: QueryResultRow; daemonId: string; transactionId: string; transactionNonce: string;
    artifactSha256: string; sourceConnectionEpoch: number; expectedRunIds: string[];
    rollback: boolean; at: string;
  }): Promise<QueryResultRow> {
    if (!fullDigest(input.artifactSha256) || input.transactionNonce.length > 512) {
      throw new MachineControlError("machine_activation_identity_invalid", 400,
        "Machine Daemon activation evidence is invalid");
    }
    const nonceDigest = await sha256Hex(input.transactionNonce);
    const runSetDigest = await digest([...input.expectedRunIds].sort());
    const existing = await this.activation(tx, input.daemonId);
    if (existing && existing.transaction_id === input.transactionId &&
        existing.transaction_nonce_sha256 === nonceDigest &&
        existing.artifact_sha256 === input.artifactSha256 &&
        Number(existing.source_connection_epoch) === input.sourceConnectionEpoch) return existing;
    if (input.rollback) {
      if (!existing || ACTIVATION_TERMINAL_PHASES.has(String(existing.phase))) throw new MachineControlError(
        "machine_activation_rollback_unavailable", 409,
        "Machine Daemon activation conflicts with authoritative state");
    } else if (existing && !ACTIVATION_TERMINAL_PHASES.has(String(existing.phase))) {
      throw new MachineControlError("machine_activation_conflict", 409,
        "Machine Daemon activation conflicts with authoritative state");
    }
    if (Number(input.daemon.connection_epoch) !== input.sourceConnectionEpoch) throw new MachineControlError(
      "machine_activation_source_epoch_mismatch", 409,
      "Machine Daemon activation conflicts with authoritative state");
    if (existing) await tx.query({ name: "machine_activation_replace_v1", text:
      "DELETE FROM data.machine_daemon_activations WHERE daemon_id=$1 AND version=$2",
    values: [input.daemonId, existing.version], maxRows: 0 });
    const rows = await tx.query<QueryResultRow>({ name: "machine_activation_begin_v1", text: `INSERT INTO
      data.machine_daemon_activations
      (daemon_id,transaction_id,transaction_nonce_sha256,artifact_sha256,source_connection_epoch,
       provisional_connection_epoch,phase,expected_run_ids_json,expected_run_set_digest,
       run_set_digest,prepared_receipt_id,active_fenced_receipt_id,active_receipt_id,
       version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'recovering',$7::jsonb,$8,NULL,NULL,NULL,NULL,1,$9,$9)
      RETURNING *`, values: [input.daemonId, input.transactionId, nonceDigest,
    input.artifactSha256, input.sourceConnectionEpoch, input.sourceConnectionEpoch + 1,
    JSON.stringify([...input.expectedRunIds].sort()), runSetDigest, input.at], maxRows: 1 });
    return rows[0]!;
  }

  private async assertRunEvidence(tx: DatabaseTransaction, input: {
    ownerUserId: string; machineId: string; hostId: string; adoptedRunIds: string[];
    naturalTerminalRunIds: string[]; adoptedRuns: unknown;
  }): Promise<void> {
    const evidence = Array.isArray(input.adoptedRuns) ? input.adoptedRuns.map((value) => record(
      value, "payload.adoptedRuns[]")) : (() => { throw new MachineControlError(
        "machine_activation_invalid", 400, "payload.adoptedRuns is invalid"); })();
    if (evidence.length !== input.adoptedRunIds.length || evidence.length > MACHINE_ACTIVATION_RUN_LIMIT ||
        evidence.some((row) => !input.adoptedRunIds.includes(text(row.runId, "adoptedRuns.runId", 200)) ||
          !fullDigest(row.adoptionKeyHash) || !fullDigest(row.executableSha256) ||
          typeof row.wrapperNonce !== "string" || row.wrapperNonce.length < 32 ||
          typeof row.processBirthId !== "string" || !/^\d{1,20}$/u.test(row.processBirthId))) {
      throw new MachineControlError("machine_activation_run_evidence_conflict", 409,
        "Adopted Run proof set does not match the accounted Run set");
    }
    const expected = [...input.adoptedRunIds, ...input.naturalTerminalRunIds];
    if (expected.length === 0) return;
    const routes = await tx.query<QueryResultRow>({ name: "machine_activation_routes_v2", text: `SELECT
      run_id,terminal_at FROM data.machine_run_routes WHERE owner_user_id=$1 AND machine_id=$2 AND run_id=ANY($3::text[]) ORDER BY run_id LIMIT $4`,
    values: [input.ownerUserId, input.machineId, expected, expected.length + 1],
    maxRows: expected.length + 1 });
    const routeMap = new Map(routes.map((row) => [String(row.run_id), row.terminal_at]));
    if (input.adoptedRunIds.some((id) => !routeMap.has(id) || routeMap.get(id) !== null) ||
        input.naturalTerminalRunIds.some((id) => !routeMap.get(id))) throw new MachineControlError(
      "machine_activation_run_evidence_conflict", 409,
      "Machine Daemon Run adoption evidence conflicts with authoritative lifecycle state");
    if (input.adoptedRunIds.length === 0) return;
    const runs = await tx.query<QueryResultRow>({ name: "machine_activation_run_evidence_v1", text: `SELECT
      run_id,metadata_json FROM data.runs WHERE run_id=ANY($1::text[]) ORDER BY run_id LIMIT $2`,
    values: [input.adoptedRunIds, input.adoptedRunIds.length + 1],
    maxRows: input.adoptedRunIds.length + 1 });
    const metadata = new Map(runs.map((row) => [String(row.run_id), row.metadata_json as Record<string, unknown>]));
    for (const row of evidence) {
      const continuity = metadata.get(String(row.runId))?.continuity;
      const bound = continuity && typeof continuity === "object" && !Array.isArray(continuity)
        ? continuity as Record<string, unknown> : {};
      if (["adoptionKeyHash", "wrapperNonce", "processBirthId", "executableSha256"]
        .some((field) => bound[field] !== row[field])) throw new MachineControlError(
        "machine_activation_run_evidence_conflict", 409,
        "Run challenge evidence does not match its Hub execution binding");
    }
  }

  private async activationCommand(tx: DatabaseTransaction, context: {
    input: Record<string, unknown>; action: string; current: QueryResultRow; daemonId: string;
    ownerUserId: string; machineId: string; hostId: string; commandId: string;
    connectionEpoch?: number; payload: Record<string, unknown>; at: string;
  }): Promise<Record<string, unknown>> {
    const liveRunIds = await this.liveRunIds(tx, context);
    if (context.action === "migration_preflight") return {
      empty: liveRunIds.length === 0, connectionEpoch: Number(context.current.connection_epoch), liveRunIds,
    };
    const control = (activation: Record<string, unknown>, daemonRow = context.current) => ({
      daemon: daemon(daemonRow), connectionEpoch: activation.connectionEpoch, activation,
      audit: { commandId: context.commandId, action: context.action, at: context.at, persisted: false },
    });
    if (context.action === "migration_fence" && liveRunIds.length > 0) return {
      empty: false, connectionEpoch: Number(context.current.connection_epoch), liveRunIds,
    };
    if (["migration_fence", "recover_connect", "activation_begin"].includes(context.action)) {
      const source = context.action === "recover_connect"
        ? record(context.input.activation, "activation") : context.payload;
      const mode = context.action === "recover_connect" ? source.mode : undefined;
      if (context.action === "recover_connect" && mode !== "recovering" && mode !== "rollback") {
        throw new MachineControlError("machine_activation_invalid", 400,
          "Machine Daemon recovery connect requires recovering mode");
      }
      const sourceEpoch = integer(source.sourceConnectionEpoch, "sourceConnectionEpoch", 1);
      if (context.action === "activation_begin" && sourceEpoch !== context.connectionEpoch) {
        throw new MachineControlError("machine_activation_source_epoch_mismatch", 409,
          "Machine activation must fence the caller's exact live epoch");
      }
      const row = await this.beginActivation(tx, { daemon: context.current, daemonId: context.daemonId,
        transactionId: text(source.transactionId, "transactionId", 200),
        transactionNonce: text(source.transactionNonce, "transactionNonce", 512),
        artifactSha256: text(source.artifactSha256, "artifactSha256", 64), sourceConnectionEpoch: sourceEpoch,
        expectedRunIds: liveRunIds, rollback: mode === "rollback", at: context.at });
      const receipt = activationReceipt(row);
      if (context.action === "migration_fence") return {
        empty: true, connectionEpoch: sourceEpoch, liveRunIds, activation: receipt,
      };
      return control(receipt);
    }
    const row = await this.activation(tx, context.daemonId);
    if (!row || row.transaction_id !== context.payload.transactionId ||
        row.artifact_sha256 !== context.payload.artifactSha256 ||
        Number(row.provisional_connection_epoch) !== context.connectionEpoch) throw new MachineControlError(
      "machine_activation_identity_mismatch", 409,
      "Machine Daemon activation conflicts with authoritative state");
    if (context.action === "activation_prepare") {
      const expected = activationRunIds(context.payload.expectedRunIds, "expectedRunIds");
      const adopted = activationRunIds(context.payload.adoptedRunIds, "adoptedRunIds");
      const terminal = activationRunIds(context.payload.naturalTerminalRunIds, "naturalTerminalRunIds");
      if (!fullDigest(context.payload.runSetDigest) ||
          !sameSet(expected, [...adopted, ...terminal]) || adopted.some((id) => terminal.includes(id)) ||
          !sameSet(expected, (row.expected_run_ids_json as unknown[]).map(String)) ||
          context.payload.runSetDigest !== row.expected_run_set_digest) throw new MachineControlError(
        "machine_activation_run_accounting_incomplete", 400,
        "Machine Daemon activation evidence is invalid");
      await this.assertRunEvidence(tx, { ...context, adoptedRunIds: adopted,
        naturalTerminalRunIds: terminal, adoptedRuns: context.payload.adoptedRuns });
      if (row.phase === "activation_prepared" && row.run_set_digest === context.payload.runSetDigest) {
        return control(activationReceipt(row));
      }
      if (row.phase !== "recovering") throw new MachineControlError(
        "machine_activation_phase_conflict", 409,
        "Machine Daemon activation conflicts with authoritative state");
      const receiptId = `prepared:${String(row.transaction_id)}:${String(context.payload.runSetDigest)}`;
      const updated = (await tx.query<QueryResultRow>({ name: "machine_activation_prepare_v1", text: `UPDATE
        data.machine_daemon_activations SET phase='activation_prepared',run_set_digest=$1,
        prepared_receipt_id=$2,version=version+1,updated_at=$3 WHERE daemon_id=$4 AND version=$5 RETURNING *`,
      values: [context.payload.runSetDigest, receiptId, context.at, context.daemonId, row.version], maxRows: 1 }))[0]!;
      return control(activationReceipt(updated, receiptId));
    }
    const requested = text(context.payload.phase, "phase", 32);
    if (!["active_fenced", "active", "stable_granted", "abort"].includes(requested)) {
      throw new MachineControlError("machine_activation_invalid", 400,
        "Machine Daemon activation evidence is invalid");
    }
    const next = requested === "abort" ? "aborted" : requested;
    if (row.phase === next) return control(activationReceipt(row));
    const expectedPhase = { active_fenced: "activation_prepared", active: "active_fenced",
      stable_granted: "active", abort: "recovering" }[requested];
    if (row.phase !== expectedPhase) throw new MachineControlError(
      "machine_activation_phase_conflict", 409,
      "Machine Daemon activation conflicts with authoritative state");
    let updatedDaemon = context.current;
    if (next === "active_fenced") updatedDaemon = (await tx.query<QueryResultRow>({
      name: "machine_activation_fence_daemon_v1", text: `UPDATE data.machine_daemons SET
        connection_epoch=$1,status='online',version=version+1,updated_at=$2
        WHERE daemon_id=$3 AND connection_epoch=$4 RETURNING *`, values: [row.provisional_connection_epoch,
      context.at, context.daemonId, row.source_connection_epoch], maxRows: 1 }))[0]!;
    if (next === "active_fenced" && !updatedDaemon) throw new MachineControlError(
      "machine_activation_source_epoch_mismatch", 409,
      "Machine Daemon activation conflicts with authoritative state");
    const receiptId = `${next}:${String(row.transaction_id)}`;
    const receiptColumn = next === "active_fenced" ? "active_fenced_receipt_id"
      : next === "active" ? "active_receipt_id" : null;
    const updated = (await tx.query<QueryResultRow>({ name: "machine_activation_advance_v1", text: `UPDATE
      data.machine_daemon_activations SET phase=$1,${receiptColumn ? `${receiptColumn}=$2,` : ""}
      version=version+1,updated_at=$${receiptColumn ? "3" : "2"}
      WHERE daemon_id=$${receiptColumn ? "4" : "3"} AND version=$${receiptColumn ? "5" : "4"} RETURNING *`,
    values: receiptColumn
      ? [next, receiptId, context.at, context.daemonId, row.version]
      : [next, context.at, context.daemonId, row.version], maxRows: 1 }))[0]!;
    return control(activationReceipt(updated, receiptId), updatedDaemon);
  }

  private async commitDaemon(tx: DatabaseTransaction, input: { action: string; current?: QueryResultRow;
    daemonId: string; ownerUserId: string; ownerEmail: string; machineId: string; hostId: string;
    input: Record<string, unknown>; at: string }) {
    const status = input.action === "connect" ? "online"
      : input.action === "unregister" || input.action === "failed-deliver" ? "offline"
      : input.current ? String(input.current.status) : "enrolled";
    const projectsReachability = input.action === "connect" || input.action === "unregister" ||
      input.action === "failed-deliver" || input.action === "enroll";
    if (input.current && !projectsReachability) return input.current;
    const capabilities = Array.isArray(input.input.capabilities) ? input.input.capabilities : [];
    const body: Record<string, unknown> = input.input.metadata && typeof input.input.metadata === "object" &&
      !Array.isArray(input.input.metadata) ? { ...input.input.metadata as Record<string, unknown> } : {};
    // Connect metadata carries the daemon's cached inventory; keep only its validated shape.
    if (body.harnesses !== undefined) {
      const harnesses = parseHarnessInventory(body.harnesses);
      if (harnesses) body.harnesses = harnesses;
      else delete body.harnesses;
    }
    const observedHostname = input.input.hostname ?? input.input.hostName ?? input.hostId;
    const hostName = typeof observedHostname === "string" && observedHostname.trim()
      ? text(observedHostname, "hostname", 160) : null;
    const displayName = typeof input.input.displayName === "string" && input.input.displayName.trim()
      ? input.input.displayName.trim() : null;
    if (input.action === "enroll" || input.action === "connect") await ensureMachineName(tx, {
      ownerUserId: input.ownerUserId, machineId: input.machineId, hostName, hostId: input.hostId,
      parentMachineId: (body as Record<string, unknown>).parentMachineId });
    if (input.current) {
      const rows = await tx.query<QueryResultRow>({ name: "machine_control_daemon_update_v2", text: `UPDATE
        data.machine_daemons SET owner_email=$1,hostname=COALESCE($2,hostname),
        display_name=COALESCE($3,display_name),status=$4,
        capabilities_json=CASE WHEN jsonb_array_length($5::jsonb)>0 THEN $5::jsonb ELSE capabilities_json END,
        metadata_json=CASE WHEN $6::jsonb<>'{}'::jsonb THEN $6::jsonb ELSE metadata_json END,
        connection_epoch=connection_epoch+$7,version=version+1,updated_at=$8
        WHERE daemon_id=$9 RETURNING *`, values: [input.ownerEmail, hostName, displayName, status,
      JSON.stringify(capabilities), JSON.stringify(hostnameMetadata(body)), input.action === "connect" ? 1 : 0,
      input.at, input.daemonId], maxRows: 1 });
      return rows[0]!;
    }
    const rows = await tx.query<QueryResultRow>({ name: "machine_control_daemon_create_v2", text: `INSERT INTO
      data.machine_daemons (daemon_id,owner_user_id,owner_email,machine_id,hostname,
      display_name,status,capabilities_json,metadata_json,connection_epoch,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8::jsonb,$9::jsonb,$10,1,$11,$11) RETURNING *`,
    values: [input.daemonId, input.ownerUserId, input.ownerEmail, input.machineId, hostName,
      displayName, status, JSON.stringify(capabilities), JSON.stringify(hostnameMetadata(body)),
      input.action === "connect" ? 1 : 0, input.at], maxRows: 1 });
    return rows[0]!;
  }

  private async issue(tx: DatabaseTransaction, input: Record<string, unknown>, ownerUserId: string,
    machineId: string, hostId: string, payload: Record<string, unknown>, at: string) {
    const controlId = text(input.controlId, "controlId", 200);
    const commandType = text(input.commandType, "commandType", 32);
    if (!COMMAND_TYPES.has(commandType) || payload.requestId !== controlId) throw new MachineControlError(
      "invalid_machine_command", 400, "Machine command payload does not match its control id");
    if (commandType === "quota_probe") {
      try {
        const probe = parseRoutingQuotaProbeRequest(payload.probe);
        if (payload.type !== "machine_quota_probe" || probe.requestId !== controlId ||
            Object.keys(payload).some(key => !["type", "requestId", "probe"].includes(key))) {
          throw new Error("Invalid quota probe envelope");
        }
        const current = await tx.query({ name: "machine_quota_probe_epoch_v3", text: `SELECT 1
          FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            AND status='online' AND connection_epoch=$3
            AND capabilities_json ? 'machine_quota_probe_v2' FOR SHARE`,
        values: [ownerUserId, machineId, probe.connectionEpoch], maxRows: 1 });
        if (!current[0]) throw new Error("Quota probe daemon unavailable");
      } catch {
        throw new MachineControlError("invalid_quota_probe", 409, "Quota probe requires the exact capable online daemon");
      }
    }
    if (commandType === "harness_action") {
      try {
        const action = parseHarnessActionRequest(payload);
        if (payload.type !== "machine_harness_action" || action.requestId !== controlId ||
            Object.keys(payload).some(key => !["type", "requestId", "presetId", "action", "code"].includes(key)) ||
            !harnessActionAvailable(agentPresetById(action.presetId)?.management, action.action)) {
          throw new Error("Invalid harness action envelope");
        }
      } catch {
        throw new MachineControlError("invalid_harness_action", 400, "Harness action names an unknown preset or action");
      }
      const requiresCursorLauncher = payload.presetId === "cursor" && payload.action === "update";
      if (requiresCursorLauncher) {
        const safe = await tx.query({ name: "machine_harness_cursor_launcher_v2", text: `SELECT 1
          FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            AND status='online' AND capabilities_json ? $3 FOR SHARE`,
        values: [ownerUserId, machineId, MACHINE_HARNESS_CURSOR_LAUNCHER_CAPABILITY], maxRows: 1 });
        if (!safe[0]) throw new MachineControlError("harness_action_unavailable", 409,
          "Update this machine's daemon before updating Cursor");
      }
      if (payload.action === "uninstall") {
        const capable = await tx.query({ name: "machine_harness_uninstall_v2", text: `SELECT 1
          FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            AND status='online' AND capabilities_json ? $3 FOR SHARE`,
        values: [ownerUserId, machineId, MACHINE_HARNESS_UNINSTALL_CAPABILITY], maxRows: 1 });
        if (!capable[0]) throw new MachineControlError("harness_action_unavailable", 409,
          "Update this machine's daemon before uninstalling harnesses");
      }
      if (HARNESS_LOGIN_ACTIONS.includes(payload.action as never)) {
        const capable = await tx.query({ name: "machine_harness_login_v1", text: `SELECT 1
          FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            AND status='online' AND capabilities_json ? $3 FOR SHARE`,
        values: [ownerUserId, machineId, MACHINE_HARNESS_LOGIN_CAPABILITY], maxRows: 1 });
        if (!capable[0]) throw new MachineControlError("harness_action_unavailable", 409,
          "Update this machine's daemon before signing in to harnesses from here");
      }
      if (payload.action === "release") {
        const capable = await tx.query({ name: "machine_harness_release_v1", text: `SELECT 1
          FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
            AND status='online' AND capabilities_json ? $3 FOR SHARE`,
        values: [ownerUserId, machineId, MACHINE_HARNESS_RELEASE_CAPABILITY], maxRows: 1 });
        if (!capable[0]) throw new MachineControlError("harness_action_unavailable", 409,
          "This machine's daemon cannot receive harness releases yet");
      }
      const current = await tx.query({ name: "machine_harness_action_daemon_v2", text: `SELECT 1
        FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
          AND status='online' AND capabilities_json ? $3 FOR SHARE`,
      values: [ownerUserId, machineId, MACHINE_HARNESS_ACTION_CAPABILITY], maxRows: 1 });
      if (!current[0]) throw new MachineControlError("harness_action_unavailable", 409,
        "The Machine is offline or its xMatrix daemon cannot manage harnesses yet");
    }
    if (commandType === "worktree_action") {
      try {
        const action = parseWorktreeActionRequest(payload);
        if (payload.type !== "machine_worktree_action" || action.requestId !== controlId ||
            Object.keys(payload).some(key => !["type", "requestId", "action", "paths"].includes(key))) {
          throw new Error("Invalid worktree action envelope");
        }
      } catch {
        throw new MachineControlError("invalid_worktree_action", 400, "Worktree action is invalid");
      }
      const current = await tx.query({ name: "machine_worktree_action_daemon_v1", text: `SELECT 1
        FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2
          AND status='online' AND capabilities_json ? $3 FOR SHARE`,
      values: [ownerUserId, machineId, MACHINE_WORKTREE_ACTION_CAPABILITY], maxRows: 1 });
      if (!current[0]) throw new MachineControlError("worktree_action_unavailable", 409,
        "The Machine is offline or its xMatrix daemon cannot manage worktrees yet");
    }
    if (commandType === "recover_reply") {
      for (const field of ["runId", "instanceId", "executionKey", "channelId", "executionId"]) text(payload[field], `payload.${field}`, 300);
      if (Object.keys(payload).some(key => !["type", "requestId", "runId", "instanceId", "executionKey", "channelId", "executionId", "messageId", "relayLease"].includes(key))) {
        throw new MachineControlError("invalid_machine_command", 400, "Recovery command has unsupported fields");
      }
      if (payload.type !== "machine_recover_reply") throw new MachineControlError("invalid_machine_command", 400, "Recovery command type is invalid");
    }
    if (commandType === "spawn") {
      text(payload.spaceId, "payload.spaceId", 300);
      text(payload.channelId, "payload.channelId", 180);
      await requireChannelCapability(tx, { capability: "machine_new_work",
        channelId: String(payload.channelId), spaceId: String(payload.spaceId),
        principal: { kind: "user", id: ownerUserId }, error: channelCapabilityError });
    }
    const rows = await tx.query({ name: "machine_control_issue_v1", text: `INSERT INTO
      data.machine_daemon_commands
      (command_id,owner_user_id,machine_id,hostname,command_type,payload_json,status,attempts,
       lease_until,result_json,version,created_at,updated_at,lease_owner,lease_generation,
       available_at,expires_at,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending',0,NULL,NULL,1,$7,$7,NULL,0,$7,$8,NULL)
      ON CONFLICT (command_id) DO NOTHING RETURNING command_id`, values: [controlId, ownerUserId,
      machineId, hostId, commandType, JSON.stringify(payload), at,
      new Date(Date.parse(at) + (commandType === "quota_probe" ? 15_000
        : commandType === "harness_action" ? HARNESS_ACTION_CLAIM_TTL_MS
          : commandType === "worktree_action" ? WORKTREE_ACTION_CLAIM_TTL_MS : COMMAND_TTL_MS)).toISOString()], maxRows: 1 });
    if (!rows[0]) throw new MachineControlError("machine_command_exists", 409,
      "Machine command already exists");
    if (commandType === "spawn" || commandType === "stop" &&
        typeof payload.channelId === "string" && payload.channelId.trim()) {
      const runId = text(payload.runId, "payload.runId", 300);
      const channelId = text(payload.channelId, "payload.channelId", 180);
      const executionKey = commandType === "spawn"
        ? text(payload.executionKey, "payload.executionKey", 200)
        : typeof payload.executionKey === "string" && payload.executionKey.trim()
          ? text(payload.executionKey, "payload.executionKey", 200)
          : controlId;
      const routes = await tx.query({ name: "machine_control_run_route_v2", text: `INSERT INTO
        data.machine_run_routes
        (run_id,owner_user_id,machine_id,hostname,channel_id,execution_key,created_at,updated_at,terminal_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,NULL) ON CONFLICT (run_id) DO UPDATE SET
        updated_at=EXCLUDED.updated_at WHERE data.machine_run_routes.owner_user_id=EXCLUDED.owner_user_id
        AND data.machine_run_routes.machine_id=EXCLUDED.machine_id
        AND data.machine_run_routes.channel_id=EXCLUDED.channel_id
        AND ($8::boolean=FALSE OR data.machine_run_routes.execution_key=EXCLUDED.execution_key)
        RETURNING run_id`, values: [runId, ownerUserId, machineId, hostId, channelId, executionKey,
        at, commandType === "spawn"], maxRows: 1 });
      if (!routes[0]) throw new MachineControlError("run_route_conflict", 409,
        "Run route is already bound to another Machine target");
    }
  }

  private async issueBatch(tx: DatabaseTransaction, input: Record<string, unknown>, ownerUserId: string,
    machineId: string, hostId: string, at: string): Promise<Record<string, unknown>[]> {
    if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 100) {
      throw new MachineControlError("invalid_machine_command", 400,
        "Machine command batch must contain one to 100 commands");
    }
    const commands = input.commands.map((value, index) => {
      const command = record(value, `commands[${index}]`);
      const controlId = text(command.controlId, `commands[${index}].controlId`, 200);
      const commandType = text(command.commandType, `commands[${index}].commandType`, 32);
      const payload = record(command.payload, `commands[${index}].payload`);
      if (commandType !== "spawn" || payload.requestId !== controlId) throw new MachineControlError(
        "invalid_machine_command", 400, "Batch publication accepts exact spawn commands only");
      return { controlId, commandType, payload,
        spaceId: text(payload.spaceId, "payload.spaceId", 300),
        runId: text(payload.runId, "payload.runId", 300),
        channelId: text(payload.channelId, "payload.channelId", 180),
        executionKey: text(payload.executionKey, "payload.executionKey", 200) };
    });
    if (new Set(commands.map((command) => command.controlId)).size !== commands.length ||
        new Set(commands.map((command) => command.runId)).size !== commands.length) {
      throw new MachineControlError("invalid_machine_command", 400,
        "Machine command batch contains duplicate identities");
    }
    const encoded = commands.map((command) => ({ command_id: command.controlId,
      command_type: command.commandType, payload: command.payload, run_id: command.runId,
      channel_id: command.channelId, execution_key: command.executionKey }));
    const authorized = await tx.query<QueryResultRow>({ name: "machine_control_issue_batch_channels_v3",
      text: `SELECT c.channel_id FROM data.channels c
        JOIN jsonb_to_recordset($1::jsonb) AS requested(channel_id text,space_id text)
          ON requested.channel_id=c.channel_id AND requested.space_id=c.space_id
        WHERE ${channelCapabilityPredicate({ capability: "machine_new_work", channelAlias: "c",
          principalKindSql: "'user'", principalIdSql: "$2" })}
        ORDER BY c.channel_id FOR SHARE OF c`,
      values: [JSON.stringify(commands.map(({ channelId, spaceId }) => ({
        channel_id: channelId, space_id: spaceId,
      }))), ownerUserId], maxRows: commands.length });
    if (new Set(authorized.map((row) => String(row.channel_id))).size !==
        new Set(commands.map((command) => command.channelId)).size) {
      throw new MachineControlError("channel_not_found", 404, "Channel not found");
    }
    const expiresAt = new Date(Date.parse(at) + COMMAND_TTL_MS).toISOString();
    const inserted = await tx.query<QueryResultRow>({ name: "machine_control_issue_batch_v1", text: `INSERT INTO
        data.machine_daemon_commands
        (command_id,owner_user_id,machine_id,hostname,command_type,payload_json,status,attempts,
         lease_until,result_json,version,created_at,updated_at,lease_owner,lease_generation,
         available_at,expires_at,completed_at)
      SELECT x.command_id,$2,$3,$4,x.command_type,x.payload,'pending',0,NULL,NULL,1,$5,$5,NULL,0,$5,$6,NULL
      FROM jsonb_to_recordset($1::jsonb)
        AS x(command_id text,command_type text,payload jsonb,run_id text,channel_id text,execution_key text)
      ON CONFLICT (command_id) DO NOTHING RETURNING command_id`,
    values: [JSON.stringify(encoded), ownerUserId, machineId, hostId, at, expiresAt],
    maxRows: commands.length });
    const insertedIds = new Set(inserted.map((row) => String(row.command_id)));
    const rows = await tx.query<QueryResultRow>({ name: "machine_control_issue_batch_read_v1", text: `SELECT
        command_id,owner_user_id,machine_id,hostname,command_type,payload_json,status,result_json,created_at
      FROM data.machine_daemon_commands WHERE command_id=ANY($1::text[]) ORDER BY command_id`,
    values: [commands.map((command) => command.controlId)], maxRows: commands.length });
    if (rows.length !== commands.length) throw new MachineControlError(
      "machine_command_batch_incomplete", 500, "Machine command batch did not persist completely");
    const expected = new Map(commands.map((command) => [command.controlId, command]));
    for (const row of rows) {
      const command = expected.get(String(row.command_id));
      if (!command || row.owner_user_id !== ownerUserId || row.machine_id !== machineId ||
          row.command_type !== command.commandType ||
          stable(row.payload_json) !== stable(command.payload)) throw new MachineControlError(
        "idempotency_mismatch", 409, "Existing Machine command differs from batch publication");
    }
    const routeRows = await tx.query<QueryResultRow>({ name: "machine_control_run_routes_batch_v2", text: `INSERT INTO
        data.machine_run_routes
        (run_id,owner_user_id,machine_id,hostname,channel_id,execution_key,created_at,updated_at,terminal_at)
      SELECT x.run_id,$2,$3,$4,x.channel_id,x.execution_key,$5,$5,NULL
      FROM jsonb_to_recordset($1::jsonb)
        AS x(command_id text,command_type text,payload jsonb,run_id text,channel_id text,execution_key text)
      ON CONFLICT (run_id) DO UPDATE SET updated_at=EXCLUDED.updated_at
      WHERE data.machine_run_routes.owner_user_id=EXCLUDED.owner_user_id
        AND data.machine_run_routes.machine_id=EXCLUDED.machine_id
        AND data.machine_run_routes.channel_id=EXCLUDED.channel_id
        AND data.machine_run_routes.execution_key=EXCLUDED.execution_key
      RETURNING run_id`, values: [JSON.stringify(encoded), ownerUserId, machineId, hostId, at],
    maxRows: commands.length });
    if (routeRows.length !== commands.length) throw new MachineControlError(
      "run_route_conflict", 409, "A Run route is already bound to another Machine target");
    return rows.map((row) => ({ controlId: String(row.command_id), status: String(row.status),
      ...(row.result_json && typeof row.result_json === "object"
        ? { result: row.result_json as Record<string, unknown> } : {}),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      reused: !insertedIds.has(String(row.command_id)) }));
  }

  private async claim(tx: DatabaseTransaction, input: Record<string, unknown>, current: QueryResultRow,
    connectionEpoch: number, at: string) {
    const types = Array.isArray(input.commandTypes)
      ? input.commandTypes.map((value) => text(value, "commandTypes[]", 32)) : [];
    if (types.some((value) => !COMMAND_TYPES.has(value))) throw new MachineControlError(
      "invalid_machine_command", 400, "Machine claim includes an unknown command type");
    const leaseMs = Math.min(integer(input.leaseMs ?? 30_000, "leaseMs", 1), 60_000);
    const leaseOwner = `machine-daemon:${String(current.owner_user_id)}:${String(current.machine_id)}:epoch:${connectionEpoch}`;
    await tx.query({ name: "machine_control_unanswered_fail_v1", text: `UPDATE data.machine_daemon_commands SET
        status='failed',result_json=jsonb_build_object('ok',false,'error',$3::text),lease_owner=NULL,lease_until=NULL,
        completed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
      WHERE owner_user_id=$1 AND machine_id=$2 AND attempts>=$4
        AND (status='pending' OR (status='leased' AND lease_until<=clock_timestamp()))`,
    values: [current.owner_user_id, current.machine_id, UNANSWERED_FAILURE, MAX_UNANSWERED_DELIVERIES], maxRows: 0 });
    const rows = await tx.query<QueryResultRow>({ name: "machine_control_claim_candidates_v8", text: `SELECT
      command.command_id,command.command_type,
      CASE WHEN command.command_type='spawn' AND launch.launch_id IS NOT NULL
        THEN command.payload_json || jsonb_build_object(
          'spaceId',launch.space_id,'channelId',launch.channel_id,
          'runId',launch.run_id,'instanceId',launch.instance_id,
          'requestId',command.command_id,'launchId',launch.launch_id,
          'executionKey',launch.execution_key)
        ELSE command.payload_json END AS payload_json,
      command.version,command.lease_generation
      FROM data.machine_daemon_commands command
      LEFT JOIN data.agent_launches launch ON launch.control_id=command.command_id
      WHERE command.owner_user_id=$1 AND command.machine_id=$2
        AND (command.status='pending' OR
          (command.status='leased' AND command.lease_until<=clock_timestamp()))
        AND COALESCE(command.available_at,command.created_at)<=clock_timestamp()
        AND (command.expires_at IS NULL OR command.expires_at>clock_timestamp())
        AND (cardinality($3::text[])=0 OR command.command_type=ANY($3::text[]))
        AND (command.command_type<>'quota_probe' OR
          ($4::boolean AND command.payload_json->'probe'->>'connectionEpoch'=$5::text))
        AND (command.command_type<>'harness_action' OR ($6::boolean AND
          (command.payload_json->>'presetId'<>'cursor' OR command.payload_json->>'action'<>'update' OR $7::boolean) AND
          (command.payload_json->>'action'<>'uninstall' OR $8::boolean) AND
          (command.payload_json->>'action'<>'release' OR $9::boolean) AND
          (command.payload_json->>'action' NOT LIKE 'login%' OR $10::boolean)))
        AND (command.command_type<>'worktree_action' OR $11::boolean)
      ORDER BY command.created_at,command.command_id LIMIT 5
      FOR UPDATE OF command SKIP LOCKED`, values: [current.owner_user_id, current.machine_id, types, Array.isArray(current.capabilities_json) && current.capabilities_json.includes("machine_quota_probe_v2"), String(connectionEpoch), Array.isArray(current.capabilities_json) && current.capabilities_json.includes(MACHINE_HARNESS_ACTION_CAPABILITY), Array.isArray(current.capabilities_json) && current.capabilities_json.includes(MACHINE_HARNESS_CURSOR_LAUNCHER_CAPABILITY), Array.isArray(current.capabilities_json) && current.capabilities_json.includes(MACHINE_HARNESS_UNINSTALL_CAPABILITY), Array.isArray(current.capabilities_json) && current.capabilities_json.includes(MACHINE_HARNESS_RELEASE_CAPABILITY), Array.isArray(current.capabilities_json) && current.capabilities_json.includes(MACHINE_HARNESS_LOGIN_CAPABILITY), Array.isArray(current.capabilities_json) && current.capabilities_json.includes(MACHINE_WORKTREE_ACTION_CAPABILITY)],
    maxRows: 5 });
    const commands = [];
    for (const row of rows) {
      const updated = await tx.query<QueryResultRow>({ name: "machine_control_claim_v2", text: `UPDATE
        data.machine_daemon_commands SET status='leased',attempts=attempts+1,lease_owner=$1,
        lease_generation=COALESCE(lease_generation,0)+1,
        lease_until=clock_timestamp()+($2::integer*interval '1 millisecond'),
        version=version+1,updated_at=clock_timestamp()
        WHERE command_id=$3 AND version=$4 RETURNING version,lease_generation,lease_until`,
      values: [leaseOwner, leaseMs, row.command_id, row.version], maxRows: 1 });
      const lease = updated[0];
      if (!lease) throw new MachineControlError("machine_command_stale_lease", 409,
        "Machine claim lost its compare-and-swap race");
      const relayLease = { leaseOwner, leaseGeneration: Number(lease.lease_generation),
        entityVersion: Number(lease.version), daemonEpoch: connectionEpoch };
      commands.push({ controlId: row.command_id, commandType: row.command_type,
        payload: { ...(row.payload_json as Record<string, unknown>), relayLease },
        leaseUntil: new Date(lease.lease_until as string | Date).toISOString(),
        ...relayLease });
    }
    return { daemon: daemon(current), connectionEpoch, audit: {
      commandId: input.commandId, action: "claim", at, persisted: false }, commands };
  }

  /**
   * The exact lease a daemon holds. Renewal and retry need it live in this
   * connection. A result does not: the process it describes already ran, and
   * the lease generation alone fences it. While nobody re-claimed the command
   * its holder may still record how it ended after the lease lapsed or the
   * connection turned over; refusing that left the command to be claimed and
   * run a second time, and whoever waited on it saw nothing for hours.
   */
  private async exactLeased(tx: DatabaseTransaction, input: Record<string, unknown>, ownerUserId: string,
    machineId: string, connectionEpoch: number, fence: "live" | "generation" = "live") {
    const controlId = text(input.controlId, "controlId", 200);
    const lease = record(input.relayLease, "relayLease");
    const leaseOwner = text(lease.leaseOwner, "relayLease.leaseOwner", 700);
    if (fence === "live" && lease.daemonEpoch !== connectionEpoch) throw new MachineControlError(
      "machine_command_stale_lease", 409, "Machine lease belongs to another Daemon epoch");
    const rows = await tx.query<QueryResultRow>({ name: "machine_control_lease_lock_v3", text: `SELECT *,
      lease_until>clock_timestamp() AND (command_type<>'quota_probe' OR expires_at>clock_timestamp()) AS lease_live
      FROM data.machine_daemon_commands WHERE command_id=$1 AND owner_user_id=$2 AND machine_id=$3 FOR UPDATE`, values: [controlId, ownerUserId, machineId], maxRows: 1 });
    const command = rows[0];
    if (!command) throw new MachineControlError("machine_command_not_found", 404,
      "Machine command not found");
    if (command.status !== "leased" || command.lease_owner !== leaseOwner ||
        Number(command.lease_generation) !== integer(lease.leaseGeneration, "leaseGeneration", 1) ||
        Number(command.version) !== integer(lease.entityVersion, "entityVersion", 2) ||
        (fence === "live" && command.lease_live !== true)) {
      throw new MachineControlError("machine_command_stale_lease", 409,
        "Machine command lease is stale");
    }
    return { command, controlId, leaseOwner };
  }

  private async renew(tx: DatabaseTransaction, input: Record<string, unknown>, current: QueryResultRow,
    connectionEpoch: number, at: string) {
    const exact = await this.exactLeased(tx, input, String(current.owner_user_id),
      String(current.machine_id), connectionEpoch);
    if (input.expected !== undefined) {
      const expected = record(input.expected, "expected");
      const issued = record(exact.command.payload_json, "issuedPayload");
      const issuedWorkspace = record(issued.workspace, "issuedPayload.workspace");
      // A reborn successor is issued without a Launch; then the admission must
      // carry none either, and every other field still binds it to the command.
      const launchless = (value: unknown) => value === undefined || value === null;
      if (launchless(expected.launchId) !== launchless(issued.launchId) ||
          (!launchless(expected.launchId) &&
            text(expected.launchId, "expected.launchId", 300) !==
              text(issued.launchId, "issuedPayload.launchId", 300))) {
        throw new MachineControlError(
          "machine_command_payload_mismatch", 409, "Machine command launchId does not match",
        );
      }
      for (const field of ["spaceId", "runId", "instanceId", "executionKey", "channelId"] as const) {
        if (text(expected[field], `expected.${field}`, 300) !==
            text(issued[field], `issuedPayload.${field}`, 300)) {
          throw new MachineControlError(
            "machine_command_payload_mismatch", 409, `Machine command ${field} does not match`,
          );
        }
      }
      if (text(expected.agentId, "expected.agentId", 300) !==
          text(issued.identityId, "issuedPayload.identityId", 300) ||
          text(expected.workspaceCanonicalCwd, "expected.workspaceCanonicalCwd", 4_000) !==
          text(issuedWorkspace.canonicalCwd, "issuedPayload.workspace.canonicalCwd", 4_000)) {
        throw new MachineControlError(
          "machine_command_payload_mismatch", 409, "Machine command spawn authority does not match",
        );
      }
    }
    const leaseMs = Math.min(integer(input.leaseMs ?? 60_000, "leaseMs", 1), 60_000);
    const rows = await tx.query<QueryResultRow>({ name: "machine_control_renew_v2", text: `UPDATE
      data.machine_daemon_commands
      SET lease_until=clock_timestamp()+($1::integer*interval '1 millisecond'),
        updated_at=clock_timestamp()
      WHERE command_id=$2 AND version=$3 AND lease_owner=$4 RETURNING version,lease_until`, values: [leaseMs,
      exact.controlId, exact.command.version, exact.leaseOwner], maxRows: 1 });
    if (!rows[0]) throw new MachineControlError("machine_command_stale_lease", 409,
      "Machine command renewal lost its compare-and-swap race");
    return { daemon: daemon(current), connectionEpoch, audit: {
      commandId: input.commandId, action: "renew", at, persisted: false },
    leaseUntil: new Date(rows[0]!.lease_until as string | Date).toISOString(),
    controlId: exact.controlId };
  }

  private async complete(tx: DatabaseTransaction, input: Record<string, unknown>, ownerUserId: string,
    machineId: string, hostId: string, connectionEpoch: number, payload: Record<string, unknown>, at: string) {
    const controlId = text(input.controlId, "controlId", 200);
    const priorRows = await tx.query<QueryResultRow>({ name: "machine_control_complete_replay_lock_v2",
      text: `SELECT * FROM data.machine_daemon_commands WHERE command_id=$1 AND owner_user_id=$2
        AND machine_id=$3 FOR UPDATE`, values: [controlId, ownerUserId, machineId],
    maxRows: 1 });
    const prior = priorRows[0];
    if (!prior) throw new MachineControlError("machine_command_not_found", 404,
      "Machine command not found");
    if (prior.command_type === "quota_probe" &&
        parseRoutingQuotaProbeRequest((prior.payload_json as Record<string, unknown>).probe).connectionEpoch !== connectionEpoch) {
      throw new MachineControlError("machine_command_result_mismatch", 409, "Quota probe connection changed");
    }
    if (prior.status === "completed" || prior.status === "failed") {
      exactResult(String(prior.command_type), prior.payload_json as Record<string, unknown>,
        text(input.eventType, "eventType", 80), payload, controlId);
      const expectedStatus = input.success === false ? "failed" : "completed";
      if (prior.status !== expectedStatus || stable(prior.result_json) !== stable(payload)) {
        throw new MachineControlError("idempotency_mismatch", 409,
          "Machine completion replay differs from the durable result");
      }
      return { reused: true, ...completionFacts(String(prior.command_type),
        prior.payload_json as Record<string, unknown>, payload) };
    }
    const exact = await this.exactLeased(tx, input, ownerUserId, machineId, connectionEpoch,
      // A quota probe answers for one connection; its result expires with it.
      prior.command_type === "quota_probe" ? "live" : "generation");
    exactResult(String(exact.command.command_type), exact.command.payload_json as Record<string, unknown>,
      text(input.eventType, "eventType", 80), payload, exact.controlId);
    const status = input.success === false ? "failed" : "completed";
    const rows = await tx.query({ name: "machine_control_complete_v1", text: `UPDATE
      data.machine_daemon_commands SET status=$1,result_json=$2::jsonb,lease_owner=NULL,
      lease_until=NULL,version=version+1,updated_at=$3,completed_at=$3 WHERE command_id=$4
      AND version=$5 RETURNING command_id`, values: [status, JSON.stringify(payload), at,
      exact.controlId, exact.command.version], maxRows: 1 });
    if (!rows[0]) throw new MachineControlError("machine_command_stale_lease", 409,
      "Machine completion lost its compare-and-swap race");
    const issued = exact.command.payload_json as Record<string, unknown>;
    if (exact.command.command_type === "quota_probe" && status === "completed") {
      await recordRegistrationQuotaProbeResult(tx, { ownerUserId, machineId, hostId,
        issued: parseRoutingQuotaProbeRequest(issued.probe), result: payload.probe, now: Date.now() });
    }
    if (exact.command.command_type === "harness_action" && status === "completed") {
      await recordHarnessActionInventory(tx, { ownerUserId, machineId, hostId,
        result: parseHarnessActionResult(payload.result, issuedHarnessAction(issued)), at });
    }
    if (exact.command.command_type === "harness_action" && issued.code !== undefined) {
      // A pasted sign-in code is spent once the daemon answered; do not keep it.
      await tx.query({ name: "machine_harness_login_code_drop_v1", text: `UPDATE data.machine_daemon_commands
        SET payload_json=payload_json-'code' WHERE command_id=$1`, values: [exact.controlId], maxRows: 0 });
    }
    return { reused: false, ...completionFacts(String(exact.command.command_type), issued, payload) };
  }

  private async retry(tx: DatabaseTransaction, input: Record<string, unknown>, ownerUserId: string,
    machineId: string, connectionEpoch: number) {
    const exact = await this.exactLeased(tx, input, ownerUserId, machineId, connectionEpoch);
    const backoffMs = Math.min(integer(input.backoffMs ?? 0, "backoffMs"), 300_000);
    const rows = await tx.query({ name: "machine_control_retry_v2", text: `UPDATE
      data.machine_daemon_commands SET status='pending',lease_owner=NULL,lease_until=NULL,
      available_at=clock_timestamp()+($1::integer*interval '1 millisecond'),
      version=version+1,updated_at=clock_timestamp() WHERE command_id=$2 AND version=$3
      RETURNING command_id`, values: [backoffMs, exact.controlId, exact.command.version], maxRows: 1 });
    if (!rows[0]) throw new MachineControlError("machine_command_stale_lease", 409,
      "Machine retry lost its compare-and-swap race");
  }

  async list(input: { requestId: string; ownerUserId: string; cursor?: string; limit?: number }) {
    const ownerUserId = text(input.ownerUserId, "ownerUserId", 200);
    const cursor = typeof input.cursor === "string" ? input.cursor : "";
    const limit = Math.min(integer(input.limit ?? 100, "limit", 1), 200);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "machine-control.list" }, async (tx) => {
      // A retired Machine is gone from its owner's list; a live one says how many Agents it is running.
      // Reachability follows connection events only, so an online daemon also says since when it
      // left work unanswered: a command available but unclaimed, or a lease it stopped renewing,
      // for longer than UNANSWERED_AFTER_MS. Quota probes are bound to one connection and excluded.
      const rows = await tx.query<QueryResultRow>({ name: "machine_control_list_v8", text: `SELECT
        daemon.*,machine.name AS machine_name,machine.parent_machine_id,machine.auto_assign,
        (SELECT COUNT(*) FROM data.runs run WHERE run.owner_user_id=daemon.owner_user_id
          AND run.metadata_json->>'machineId'=daemon.machine_id AND run.status IN (${ACTIVE_RUN_STATUS_SQL})) AS active_runs,
        (SELECT MIN(CASE WHEN command.status='pending'
            THEN COALESCE(command.available_at,command.created_at) ELSE command.lease_until END)
          FROM data.machine_daemon_commands command
          WHERE daemon.status='online' AND command.owner_user_id=daemon.owner_user_id
            AND command.machine_id=daemon.machine_id AND command.command_type<>'quota_probe'
            AND (command.expires_at IS NULL OR command.expires_at>clock_timestamp())
            AND ((command.status='pending' AND COALESCE(command.available_at,command.created_at) BETWEEN
                clock_timestamp()-($5::integer*interval '1 millisecond') AND clock_timestamp()-($4::integer*interval '1 millisecond'))
              OR (command.status='leased' AND command.lease_until BETWEEN
                clock_timestamp()-($5::integer*interval '1 millisecond') AND clock_timestamp()-($4::integer*interval '1 millisecond')))) AS unanswered_since
        FROM data.machine_daemons daemon
        LEFT JOIN data.machines machine ON machine.owner_user_id=daemon.owner_user_id AND machine.machine_id=daemon.machine_id
        WHERE daemon.owner_user_id=$1 AND daemon.daemon_id>$2 AND machine.retired_at IS NULL
        ORDER BY daemon.daemon_id LIMIT $3`,
      values: [ownerUserId, cursor, limit + 1, UNANSWERED_AFTER_MS, UNANSWERED_WINDOW_MS], maxRows: limit + 1 });
      return { daemons: rows.slice(0, limit).map(daemon),
        cursor: rows.length > limit ? String(rows[limit - 1]?.daemon_id ?? "") : null };
    });
  }

  async getDaemon(input: { requestId: string; ownerUserId: string; machineId: string; hostId: string }) {
    const ownerUserId = text(input.ownerUserId, "ownerUserId", 200);
    const machineId = text(input.machineId, "machineId", 160);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "machine-control.get-daemon" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_control_get_daemon_v3", text: `SELECT *
        FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2 LIMIT 2`,
      values: [ownerUserId, machineId], maxRows: 2 });
      if (rows.length > 1) throw new MachineControlError("machine_identity_conflict", 409,
        "Machine has conflicting daemon records");
      return { daemon: rows[0] ? daemon(rows[0]) : null };
    });
  }

  async status(input: { requestId: string; ownerUserId: string; controlId: string;
    commandType: string; expected: Record<string, unknown>; machineId?: string; hostId?: string }) {
    const ownerUserId = text(input.ownerUserId, "ownerUserId", 200);
    const controlId = text(input.controlId, "controlId", 200);
    const commandType = text(input.commandType, "commandType", 32);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "machine-control.status" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_control_status_v3", text: `SELECT
        command_type,payload_json,status,result_json,completed_at,machine_id,hostname FROM data.machine_daemon_commands
        WHERE command_id=$1 AND owner_user_id=$2 LIMIT 1`, values: [controlId, ownerUserId], maxRows: 1 });
      const row = rows[0];
      if (!row) return { controlId, status: "missing" };
      if (input.machineId !== undefined && row.machine_id !== text(input.machineId, "machineId", 160)) {
        throw new MachineControlError("forbidden", 403, "Machine command is bound to another route");
      }
      return commandStatus(row, controlId, commandType, input.expected);
    });
  }

  async statusMany(input: { requestId: string; ownerUserId: string; machineId: string;
    hostId: string; commands: readonly { controlId: string; expected: Record<string, unknown> }[] }) {
    const ownerUserId = text(input.ownerUserId, "ownerUserId", 200);
    const machineId = text(input.machineId, "machineId", 160);
    if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 100) {
      throw new MachineControlError("invalid_machine_command", 400,
        "Machine status batch must contain one to 100 commands");
    }
    const commands = input.commands.map((item) => ({
      controlId: text(item.controlId, "controlId", 200),
      expected: record(item.expected, "expected"),
    }));
    if (new Set(commands.map((item) => item.controlId)).size !== commands.length) {
      throw new MachineControlError("invalid_machine_command", 400,
        "Machine status batch contains duplicate commands");
    }
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "machine-control.status-batch" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_control_status_batch_v2", text: `SELECT
          command_id,command_type,payload_json,status,result_json,created_at,completed_at
          FROM data.machine_daemon_commands WHERE owner_user_id=$1 AND machine_id=$2
            AND command_id=ANY($3::text[]) ORDER BY command_id`,
        values: [ownerUserId, machineId, commands.map((item) => item.controlId)],
        maxRows: commands.length });
      const daemonRows = await tx.query<QueryResultRow>({ name: "machine_control_status_batch_daemon_v2", text: `SELECT *
          FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2 LIMIT 1`,
        values: [ownerUserId, machineId], maxRows: 1 });
      const byId = new Map(rows.map((row) => [String(row.command_id), row]));
      return { daemon: daemonRows[0] ? daemon(daemonRows[0]) : null,
        commands: commands.map((item) => {
          const row = byId.get(item.controlId);
          if (!row) return { controlId: item.controlId, status: "missing" };
          return { ...commandStatus(row, item.controlId, "spawn", item.expected),
            createdAt: new Date(row.created_at as Date | string).toISOString() };
        }) };
    });
  }
}

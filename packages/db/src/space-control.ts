import { DetailedControlError } from "./control-error.js";
import type { DatabaseRequestContext } from "./context.js";
import { readsOnly } from "./space-roles.js";
import { lockTransfer, requireTransferAdmin, transferSnapshot, transferView, validateTransfer, type TransferRole, type TransferRow } from "./channel-transfer.js";
import type { QueryResultRow } from "pg";
import { channelVisibilityScope, ACTIVE_RUN_STATUS_SQL, isActiveRunStatus, parseManagementPrompt, portableNameKey, TERMINAL_RUN_STATUS_SQL, withoutRetiredManagementConfig, sha256Hex , utf8ByteLength } from "@xmatrix/protocol";
import { spaceBilling, type BillingRejection, type SpaceBillingPolicy } from "@xmatrix/billing";
import { commandDigest as digest } from "./command-digest.js";
import { readSpaceCommandReplay, storeSpaceCommandReplay } from "./command-replay.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { DatabaseContractError } from "./errors.js";
import { loadChannelAgentPresence, loadVisibleLiveAgentPresence } from "./channel-agent-presence.js";
import { insertSpaceMember, spaceMemberRole } from "./space-members.js";
import { writeOutbox } from "./outbox.js";
import { advanceSpaceControlHead } from "./space-control-head.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import {
  PostgresEntitySpaceDirectory,
  type EntitySpaceRouteKind,
} from "./entity-directory.js";
import { PostgresUserSpaceMembershipDirectory } from "./membership-directory.js";
import {
  PostgresChannelSpaceDirectory,
  PostgresSpacePlacementDirectory,
  type ChannelSpaceRoute,
  type ChannelSpaceDirectoryMutation,
  type SpacePlacement,
} from "./placement.js";
import {
  finalizeSpacePurge,
  isSpaceDeletionPending,
  listScheduledSpaceDeletions,
  lockSpaceDeletion,
  nextSpacePurgeStep,
  readSpaceDeletion,
  recordSpacePurgeObjects,
  restoreSpaceDeletion,
  scheduleSpaceDeletion,
  serializeSpaceDeletion,
  type SpacePurgeStep,
} from "./space-deletion.js";
import { channelPresentation, channelIdentity, type ChannelPresentationRow } from "./channel-metadata.js";

const MAX_PAGE = 200;
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CHANNEL_TREE_MAX = 10_000;
const ARCHIVE_STOP_TARGET_MAX = 200;
const CHANNEL_MOVE_FACT_SQL = `SET space_id = $2
          WHERE space_id = $1 AND channel_id = ANY($3::text[])`;
export type SpaceControlPrincipal = { kind: "user" | "agent"; id: string };

export interface ChannelCatalogChangeAudience {
  spaceId: string;
  revision: number;
  recipientUserIds: string[];
}

export class SpaceControlError extends DetailedControlError {
  override name = "SpaceControlError";
}

async function requiredControlHead(transaction: DatabaseTransaction,
  input: { name: string; spaceId: string; at: string }): Promise<number> {
  const sequence = await advanceSpaceControlHead(transaction, input);
  if (sequence === undefined) throw new SpaceControlError(
    "space_control_head_missing", 500, "Space control head is unavailable");
  return sequence;
}

function requireSpaceRow<T extends QueryResultRow>(rows: readonly T[]): T {
  if (!rows[0]) throw new SpaceControlError("not_found", 404, "Space not found");
  return rows[0];
}

function rejectBilling(rejection: BillingRejection | null): void {
  if (rejection) throw new SpaceControlError(
    rejection.code, rejection.status, rejection.message, rejection.retryable ?? false, rejection.details,
  );
}

export interface CreatePostgresSpace {
  requestId: string;
  commandId: string;
  spaceId: string;
  ownerUserId: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePostgresChannel {
  requestId: string;
  commandId: string;
  channelId: string;
  spaceId: string;
  name: string;
  mode: "open" | "closed";
  principal: SpaceControlPrincipal;
  metadata?: Record<string, unknown>;
  /** The live Agent Instance creating a closed Channel as its owner (the
   *  principal); it is granted the Channel with the owner. */
  creatorAgentInstanceId?: string;
}

export interface UpdatePostgresSpaceManagementConfig {
  requestId: string;
  commandId: string;
  spaceId: string;
  actorUserId: string;
  expectedVersion?: number;
  patch: Record<string, unknown>;
}

interface PostgresChannelMutationBase {
  requestId: string;
  commandId: string;
  actorUserId: string;
  at: string;
  channelId: string;
  expectedVersion?: number;
}

export type PostgresChannelMutation = PostgresChannelMutationBase & {
  kind: "channel_configure";
  mode?: "open" | "closed";
  name?: string;
  /**
   * A name xMatrix chose from the conversation itself. It only replaces a
   * name that is still automatic; any other rename makes the name a person's.
   */
  automaticName?: boolean;
  topic?: string | null;
  summary?: string | null;
  /**
   * The Run writing `summary`. The summary's source is recorded from it; a
   * summary written without one keeps no source rather than an earlier one.
   */
  summaryAuthor?: { runId: string; agentName: string; throughMessageId?: string };
  managementMetadata?: Record<string, unknown>;
  spaceId?: string;
  moveTree?: Array<{ channelId: string; expectedVersion: number }>;
};

interface PostgresMembershipMutationBase {
  requestId: string;
  commandId: string;
  actorUserId: string;
  at: string;
  expectedVersion?: number;
}

interface PostgresSpaceMutationBase {
  requestId: string;
  commandId: string;
  actorUserId: string;
  at: string;
  spaceId: string;
  expectedVersion?: number;
}

export type PostgresSpaceMutation = PostgresSpaceMutationBase & (
  | {
      kind: "space_update";
      name?: string;
      metadata?: Record<string, unknown>;
    }
  | { kind: "space_delete" }
);

export interface UpdatePostgresSpaceMemberCreationPolicy {
  requestId: string;
  commandId: string;
  actorUserId: string;
  at: string;
  spaceId: string;
  expectedVersion?: number;
  agentCreation?: "members" | "admins";
  automationCreation?: "members" | "admins";
}

export type PostgresMembershipMutation = PostgresMembershipMutationBase & (
  | {
      kind: "space_member_put";
      spaceId: string;
      userId: string;
      role: "admin" | "member" | "viewer" | "participant";
      email?: string;
      name?: string;
      avatarUrl?: string;
    }
  | { kind: "space_member_remove"; spaceId: string; userId: string }
  | {
      kind: "channel_access_put" | "channel_access_remove";
      channelId: string;
      subjectKind: "user" | "agent";
      subjectId: string;
    }
);

export interface CreatePostgresSpaceInvite {
  requestId: string;
  commandId: string;
  spaceId: string;
  actorUserId: string;
  role: "admin" | "member" | "viewer" | "participant";
  admin: boolean;
  expiresInHours?: number;
  maxUses: number | null;
  requiresApproval: boolean;
}

interface SpaceRow extends QueryResultRow {
  space_id: string;
  owner_user_id: string;
  name: string;
  metadata_json: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MemberRow extends QueryResultRow {
  space_id: string;
  user_id: string;
  role: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: Date | string;
  profile_name: string | null;
  profile_handle: string | null;
  profile_avatar_url: string | null;
  profile_bio: string | null;
  profile_time_zone: string | null;
  profile_version: string | number | null;
}

interface ChannelRow extends ChannelPresentationRow {
  creator_role?: string;
  explicit_access?: boolean;
  created_by_fallback?: string;
  search_rank_sequence?: string;
  /** Newest live message's timeline sequence; only reads that join it carry it. */
  history_head_sequence?: string | number | null;
  content_revision?: string | number | null;
  /** Newest live message's send time; appends never touch `updated_at`. */
  last_message_at?: Date | string | null;
  /** Member presentation selected with a catalog page, within its transaction. */
  visible_human_ids?: string[];
}

/**
 * An Agent principal is the Instance of a Run registered in the Space.
 */
function agentInSpacePredicate(spaceIdSql: string, principalIdSql: string): string {
  return `EXISTS (SELECT 1 FROM data.instances instance
      JOIN data.run_agent_registrations binding ON binding.run_id = instance.run_id
      WHERE binding.space_id = ${spaceIdSql} AND instance.instance_id = ${principalIdSql})`;
}

function missingPlacement(error: unknown): boolean {
  return error instanceof DatabaseContractError && error.message === "Space placement is unavailable";
}

function bounded(value: unknown, field: string, maximum = 300): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || utf8ByteLength(text) > maximum) {
    throw new SpaceControlError("invalid_command", 400, `${field} is invalid`);
  }
  return text;
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SpaceControlError("invalid_request", 400, "limit is invalid");
  }
  return Math.min(limit, MAX_PAGE);
}

/** The request, Space and principal fields of a read made in one Space. */
function principalScope(
  input: { requestId: string; spaceId: string; principal: SpaceControlPrincipal },
): { requestId: string; spaceId: string; principalId: string } {
  return {
    requestId: bounded(input.requestId, "requestId", 200),
    spaceId: bounded(input.spaceId, "spaceId"),
    principalId: bounded(input.principal.id, "principal.id"),
  };
}

function userScope(
  input: { requestId: string; spaceId: string; principal: SpaceControlPrincipal },
  forbiddenMessage: string,
): { requestId: string; spaceId: string; principalId: string } {
  const scope = principalScope(input);
  if (input.principal.kind !== "user") {
    throw new SpaceControlError("forbidden", 403, forbiddenMessage);
  }
  return scope;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new SpaceControlError("postgres_fact_invalid", 500, "PostgreSQL timestamp is invalid");
  }
  return date.toISOString();
}

function channelNameStorageKey(name: string, channelId: string): string {
  const suffix = channelId.slice(-299);
  if (suffix.length === 299) return suffix;
  return `${portableNameKey(name).slice(0, 298 - suffix.length)}\u001f${suffix}`;
}

function idempotentReplay(
  transaction: DatabaseTransaction,
  spaceId: string,
  commandId: string,
  commandKind: string,
  requestDigest: string,
): Promise<Record<string, unknown> | null> {
  return readSpaceCommandReplay(transaction, "space_control_idempotency_read_v1",
    { spaceId, commandId, commandKind, requestDigest }, () => new SpaceControlError(
      "idempotency_conflict", 409, "command id was already used for another request"));
}

/** Requires the actor to own or administer the Space. */
async function requireSpaceAdmin(transaction: DatabaseTransaction, name: string, spaceId: string,
  actorUserId: string): Promise<void> {
  const admins = await transaction.query({
    name,
    text: `SELECT user_id FROM data.space_members WHERE space_id = $1 AND user_id = $2
      AND role IN ('owner','admin') LIMIT 1`,
    values: [spaceId, actorUserId], maxRows: 1,
  });
  if (!admins[0]) throw new SpaceControlError("forbidden", 403, "Space admin required");
}

/**
 * Requires the principal to be in the Space: a user by membership, an Agent by
 * an Instance there. Returns a user's role, or null for an Agent. `statement`
 * prefixes the two statement names.
 */
async function requireSpacePrincipal(transaction: DatabaseTransaction, statement: string, spaceId: string,
  kind: SpaceControlPrincipal["kind"], principalId: string): Promise<string | null> {
  if (kind === "user") {
    const role = await spaceMemberRole(transaction, `${statement}_member_v1`, spaceId, principalId);
    if (!role) throw new SpaceControlError("space_not_found", 404, "Space not found");
    return role;
  }
  const profiles = await transaction.query({
    name: `${statement}_agent_v3`,
    text: `SELECT 1 AS present WHERE ${agentInSpacePredicate("$2", "$1")}`,
    values: [principalId, spaceId], maxRows: 1,
  });
  if (!profiles[0]) throw new SpaceControlError("channel_not_found", 404, "Channel not found");
  return null;
}

/**
 * Commits a Space-control command at `commitSequence`: publishes `payload`
 * (by default the command's result) on the Space's control outbox and stores
 * the result as the command's replay.
 */
async function commitSpaceCommand(
  transaction: DatabaseTransaction,
  input: {
    name: string;
    spaceId: string;
    commitSequence: number;
    aggregateKind: "space" | "channel" | "membership" | "space-invite" | "space-join";
    aggregateId: string;
    payload?: unknown;
    commandId: string;
    commandKind: string;
    requestDigest: string;
    result: Record<string, unknown>;
    at: string;
  },
): Promise<void> {
  await writeOutbox(transaction, {
    name: input.name,
    outboxId: `space-control:${input.spaceId}:${input.commitSequence}`,
    spaceId: input.spaceId,
    topic: "space-control",
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateSequence: input.commitSequence,
    payload: input.payload ?? input.result,
    at: input.at,
  });
  await storeSpaceCommandReplay(transaction, "space_control_idempotency_write_v1", { ...input,
    ttlMs: IDEMPOTENCY_TTL_MS });
}

function managementConfig(row: QueryResultRow | undefined): Record<string, unknown> {
  if (!row) return {
    enabled: false,
    sideEffectsEnabled: true,
    identityName: "xMatrix",
    defaultChannelVisibility: "management-visible",
    configVersion: 0,
  };
  return { ...withoutRetiredManagementConfig(row.config_json as Record<string, unknown>),
    configVersion: Number(row.version) };
}

function memberPermissions(row: QueryResultRow | undefined): Record<string, unknown> {
  return {
    agentCreation: row?.agent_creation_policy === "admins" ? "admins" : "members",
    automationCreation: row?.automation_creation_policy === "admins" ? "admins" : "members",
  };
}

function serializeSpace(
  row: SpaceRow,
  members: readonly MemberRow[],
  policy: QueryResultRow | undefined,
  config: QueryResultRow | undefined,
  pendingJoinRequestCount?: number,
): Record<string, unknown> {
  return {
    id: row.space_id,
    ownerId: row.owner_user_id,
    name: row.name,
    members: members.map((member) => ({
      userId: member.user_id,
      role: member.role,
      joinedAt: iso(member.created_at),
      ...(member.email ? { email: member.email } : {}),
      ...(member.profile_name || member.display_name
        ? { name: member.profile_name || member.display_name! } : {}),
      ...(member.profile_avatar_url || member.avatar_url
        ? { avatarUrl: member.profile_avatar_url || member.avatar_url! } : {}),
      ...(member.profile_handle ? { handle: member.profile_handle } : {}),
      ...(member.profile_bio ? { bio: member.profile_bio } : {}),
      ...(member.profile_time_zone ? { timeZone: member.profile_time_zone } : {}),
      ...(member.profile_version === null ? {} : { profileVersion: Number(member.profile_version) }),
    })),
    ...(pendingJoinRequestCount === undefined ? {} : { pendingJoinRequestCount }),
    memberPermissions: memberPermissions(policy),
    managementAgent: managementConfig(config),
    ...(row.metadata_json ? { metadata: row.metadata_json } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializeChannel(
  row: ChannelRow,
  visibleHumanIds: readonly string[],
  memberPresence: Record<string, unknown> = {},
): Record<string, unknown> {
  const { metadata, createdBy } = channelPresentation(row);
  const historyHeadSequence = Number(row.history_head_sequence ?? 0);
  const contentRevision = Number(row.content_revision ?? 0);
  if (!Number.isSafeInteger(contentRevision) || contentRevision < 0) {
    throw new SpaceControlError("channel_content_revision_invalid", 503, "Channel content revision is invalid");
  }
  // Message appends do not bump `updated_at`; a Channel's activity is the later
  // of its last configuration write and its newest message, as in the paged catalog.
  const updatedAt = row.last_message_at &&
      new Date(row.last_message_at).getTime() > new Date(row.updated_at).getTime()
    ? iso(row.last_message_at)
    : iso(row.updated_at);
  return {
    ...channelIdentity(row),
    messageCount: historyHeadSequence,
    historyHeadSequence,
    contentAuthority: { protocolVersion: 1, contentRevision },
    projectionCacheScopeId: channelVisibilityScope({ mode: row.mode, channelId: row.channel_id, spaceId: row.space_id }),
    ...(metadata ? { metadata } : {}),
    ...(row.mode === "closed"
      ? { visibleHumanMemberIds: visibleHumanIds.map((id) => `user:${id}`).sort() } : {}),
    memberPresence,
    memberReadSequences: {},
    ...(createdBy ? { createdBy } : {}),
    createdAt: iso(row.created_at),
    updatedAt,
  };
}

function channelScope(row: Pick<ChannelRow, "channel_id" | "space_id" | "mode">): string {
  return channelVisibilityScope({ mode: row.mode, channelId: row.channel_id, spaceId: row.space_id });
}

function projectionMutation(
  row: ChannelRow,
  entityVersion: number,
  operation: "upsert" | "tombstone",
): Record<string, unknown> {
  return {
    entityKind: "channel",
    entityId: row.channel_id,
    entityVersion,
    visibilityScopeId: channelScope(row),
    operation,
    ...(row.search_rank_sequence ? { searchRankSeq: row.search_rank_sequence } : {}),
  };
}

function runMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function terminalizeArchivedChannelTree(
  transaction: DatabaseTransaction,
  channelIds: readonly string[],
  at: string,
): Promise<{ archiveStopTargets: Record<string, unknown>[]; instancesKilled: number }> {
  if (channelIds.length === 0) return { archiveStopTargets: [], instancesKilled: 0 };
  const liveRows = await transaction.query<QueryResultRow & {
    instance_id: string;
    instance_status: string;
    instance_version: string | number;
    run_id: string;
    run_status: string;
    run_version: string | number;
    owner_user_id: string;
    machine_owner_user_id: string;
    metadata_json: Record<string, unknown> | null;
  }>({
    name: "channel_archive_live_targets_v2",
    text: `SELECT i.instance_id, i.status AS instance_status, i.version AS instance_version,
        r.run_id, r.status AS run_status, r.version AS run_version,
        r.owner_user_id, b.owner_user_id AS machine_owner_user_id, r.metadata_json
      FROM data.instances i
      JOIN data.runs r ON r.run_id = i.run_id
      JOIN data.run_agent_registrations b ON b.run_id = r.run_id
      WHERE i.channel_id = ANY($1::text[])
        AND r.channel_id = ANY($1::text[])
        AND (i.status <> 'offline' OR r.status IN (${ACTIVE_RUN_STATUS_SQL}))
      ORDER BY i.instance_id
      LIMIT ${ARCHIVE_STOP_TARGET_MAX + 1}`,
    values: [channelIds],
    maxRows: ARCHIVE_STOP_TARGET_MAX + 1,
  });
  if (liveRows.length > ARCHIVE_STOP_TARGET_MAX) {
    throw new SpaceControlError("conflict", 409, "archive stop target set exceeds its bound");
  }
  const archiveStopTargets: Record<string, unknown>[] = [];
  const stoppedRuns = new Set<string>();
  for (const live of liveRows) {
    if (live.instance_status !== "offline") {
      const updated = await transaction.query({
        name: "channel_archive_instance_stop_v1",
        text: `UPDATE data.instances SET status = 'offline', version = version + 1, updated_at = $2
          WHERE instance_id = $1 AND version = $3 AND status = $4 RETURNING instance_id`,
        values: [live.instance_id, at, live.instance_version, live.instance_status],
        maxRows: 1,
      });
      if (!updated[0]) throw new SpaceControlError("conflict", 409, "instance archive stop conflict");
    }
    if (isActiveRunStatus(live.run_status) &&
        !stoppedRuns.has(live.run_id)) {
      stoppedRuns.add(live.run_id);
      const updated = await transaction.query({
        name: "channel_archive_run_stop_v1",
        text: `UPDATE data.runs SET status = 'stopped', version = version + 1,
            updated_at = $2, finished_at = $2
          WHERE run_id = $1 AND owner_user_id = $3 AND version = $4 AND status = $5
          RETURNING run_id`,
        values: [live.run_id, at, live.owner_user_id, live.run_version, live.run_status],
        maxRows: 1,
      });
      if (!updated[0]) throw new SpaceControlError("conflict", 409, "run archive stop conflict");
    }
    const metadata = runMetadataRecord(live.metadata_json);
    const machineId = typeof metadata.machineId === "string" ? metadata.machineId : "";
    const hostId = typeof metadata.hostId === "string" ? metadata.hostId : "";
    if (!machineId) continue;
    archiveStopTargets.push({
      instanceId: live.instance_id,
      runId: live.run_id,
      agentId: live.instance_id,
      ownerUserId: live.owner_user_id,
      machineOwnerUserId: live.machine_owner_user_id,
      machineId,
      hostId,
      ...(typeof metadata.executionKey === "string" ? { executionKey: metadata.executionKey } : {}),
    });
  }
  return { archiveStopTargets, instancesKilled: liveRows.length };
}

/**
 * Record who wrote a Channel's summary, when, and the sequence of the newest
 * message they read. The sequence is looked up here, so only a message of this
 * Channel counts; a cleared or unattributed summary keeps no source at all.
 */
async function recordSummarySource(
  transaction: DatabaseTransaction,
  metadata: Record<string, unknown>,
  spaceId: string,
  channelId: string,
  input: Pick<Extract<PostgresChannelMutation, { kind: "channel_configure" }>, "summary" | "summaryAuthor">,
  at: string,
): Promise<void> {
  delete metadata.summarySource;
  const author = input.summaryAuthor;
  if (input.summary === null || input.summary === undefined || !author) return;
  let throughSequence: number | undefined;
  if (author.throughMessageId) {
    const rows = await transaction.query<QueryResultRow & { timeline_sequence: string | number }>({
      name: "channel_summary_through_sequence_v1",
      text: `SELECT timeline_sequence FROM data.messages
        WHERE space_id = $1 AND message_id = $2 AND channel_id = $3`,
      values: [spaceId, author.throughMessageId, channelId], maxRows: 1,
    });
    if (rows[0]) throughSequence = Number(rows[0].timeline_sequence);
  }
  metadata.summarySource = {
    author: { kind: "run", runId: author.runId, agentName: author.agentName },
    generatedAt: at,
    ...(throughSequence ? { throughSequence } : {}),
  };
}

/**
 * A Channel tree leaving its Space takes no source-Space authority with it:
 * enabled Automations pause, Channel-bound trace authority ends,
 * App subscriptions are removed, and unfinished routing and reborn work is
 * cancelled. Live Runs are stopped separately by terminalizeArchivedChannelTree.
 */
async function releaseChannelTreeForMove(
  transaction: DatabaseTransaction,
  channelIds: readonly string[],
  at: string,
): Promise<void> {
  await transaction.query({
    name: "channel_move_pause_automations_v1",
    text: `UPDATE data.automations SET enabled=false, version=version+1, updated_at=$2
      WHERE enabled AND channel_id=ANY($1::text[])`,
    values: [channelIds, at], maxRows: 0,
  });
  await transaction.query({
    name: "channel_move_expire_trace_access_v1",
    text: `UPDATE data.trace_access_grants SET status='expired', version=version+1,
        decided_at=COALESCE(decided_at,$2),
        expires_at=CASE WHEN expires_at IS NULL OR expires_at>$2 THEN $2 ELSE expires_at END
      WHERE channel_id=ANY($1::text[]) AND duration='channel' AND status IN ('pending','approved')`,
    values: [channelIds, at], maxRows: 0,
  });
  await transaction.query({
    name: "channel_move_remove_app_relations_v1",
    text: "DELETE FROM data.app_source_relations WHERE channel_id=ANY($1::text[])",
    values: [channelIds], maxRows: 0,
  });
  await transaction.query({
    name: "channel_move_remove_app_action_policies_v1",
    text: "DELETE FROM data.app_connector_action_policies WHERE channel_id=ANY($1::text[])",
    values: [channelIds], maxRows: 0,
  });
  await transaction.query({
    name: "channel_move_fail_reborn_v1",
    text: `UPDATE data.agent_reborn_intents SET state='failed', error_code='channel_moved',
        lease_owner=NULL, lease_until=NULL, updated_at=$2
      WHERE channel_id=ANY($1::text[]) AND state IN ('waiting','prepared')`,
    values: [channelIds, at], maxRows: 0,
  });
}

function uniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "23505");
}

async function moveChannelSpaceFacts(
  transaction: DatabaseTransaction,
  sourceSpaceId: string,
  targetSpaceId: string,
  channelIds: readonly string[],
): Promise<void> {
  const values = [sourceSpaceId, targetSpaceId, channelIds];
  // Reborn history follows its Channel; releaseChannelTreeForMove has already
  // ended any of it that was still in progress.
  await transaction.query({
    name: "channel_move_reborn_intents_v1",
    text: `UPDATE data.agent_reborn_intents ${CHANNEL_MOVE_FACT_SQL}`,
    values, maxRows: 0,
  });
  try {
    await transaction.query({
      name: "channel_move_messages_v1",
      text: `UPDATE data.messages ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_reactions_v1",
      text: `UPDATE data.message_reactions ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_annotations_v1",
      text: `UPDATE data.message_annotations ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_mutations_v1",
      text: `UPDATE data.message_mutations ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_attachments_v1",
      text: `UPDATE data.message_attachments ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_attachment_refs_v1",
      text: `UPDATE data.message_attachment_refs ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_delivery_cursors_v1",
      text: `UPDATE data.delivery_cursors ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_attention_v1",
      text: `UPDATE data.message_attention ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_attention_revisions_v1",
      text: `UPDATE data.message_attention_revisions ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_channel_content_counters_v1",
      text: `UPDATE data.channel_content_counters ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_agent_message_executions_v1",
      text: `UPDATE data.agent_message_executions ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_channel_message_sequences_v1",
      text: `UPDATE data.channel_message_sequences ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
    await transaction.query({
      name: "channel_move_message_sequence_reservations_v1",
      text: `UPDATE data.message_sequence_reservations ${CHANNEL_MOVE_FACT_SQL}`,
      values, maxRows: 0,
    });
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new SpaceControlError(
        "conflict", 409, "Channel message facts collide in the target Space",
      );
    }
    throw error;
  }
}

/** An optional expected version must be a safe integer no smaller than `minimum`. */
function requireExpectedVersion(value: number | undefined, minimum: 0 | 1): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new SpaceControlError("invalid_command", 400, "expectedVersion is invalid");
  }
}

/** The fields of a command a user sends about one Space. */
function actorCommand(input: { requestId: string; commandId: string; actorUserId: string; spaceId: string }) {
  return {
    requestId: bounded(input.requestId, "requestId", 200),
    commandId: bounded(input.commandId, "commandId"),
    actorUserId: bounded(input.actorUserId, "actorUserId"),
    spaceId: bounded(input.spaceId, "spaceId"),
  };
}

export class PostgresSpaceControlRepository {
  private readonly placements: PostgresSpacePlacementDirectory;
  private readonly channelDirectory: PostgresChannelSpaceDirectory;
  private readonly entityDirectory: PostgresEntitySpaceDirectory;
  private readonly membershipDirectory: PostgresUserSpaceMembershipDirectory;

  constructor(
    private readonly database: AuthorityDatabase,
    private readonly shardId: string,
    private readonly billing: SpaceBillingPolicy = spaceBilling,
  ) {
    if (database.cacheMode !== "disabled") {
      throw new SpaceControlError("cached_authority_forbidden", 500, "Space authority requires uncached PostgreSQL");
    }
    this.shardId = bounded(shardId, "shardId");
    this.placements = new PostgresSpacePlacementDirectory(database);
    this.channelDirectory = new PostgresChannelSpaceDirectory(database);
    this.entityDirectory = new PostgresEntitySpaceDirectory(database);
    this.membershipDirectory = new PostgresUserSpaceMembershipDirectory(database);
  }

  /**
   * Runs `work` in one serializable transaction on the writable placement of
   * `space`: a placement the caller already resolved, or a Space id to resolve now.
   */
  private async inSpace<T>(requestId: string, operation: string, space: string | SpacePlacement,
    work: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
    const { spaceId, shardId, placementEpoch } = typeof space === "string"
      ? await this.placement(requestId, operation, space) : space;
    return this.transaction({ isolation: "serializable", requestId, operation,
      placement: { spaceId, shardId, placementEpoch } }, work);
  }

  private async transaction<T>(context: DatabaseRequestContext,
    operation: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> {
    // Retry only a PostgreSQL serialization failure: its transaction is known to have rolled back.
    // Unknown commit results and domain conflicts retain their original recovery contract.
    for (let attempt = 0; ; attempt++) {
      try { return await this.database.transaction(context, operation); }
      catch (error) {
        if (attempt >= 2 || !error || typeof error !== "object" ||
            !("code" in error) || error.code !== "40001") throw error;
      }
    }
  }

  private async placement(requestId: string, operation: string, spaceId: string): Promise<SpacePlacement> {
    return this.placements.resolveWritable({ requestId, operation: `${operation}.placement` }, spaceId, () =>
      new SpaceControlError("space_placement_unavailable", 503, "Space placement is not writable", true));
  }

  private async publishCurrentChannelRoutes(
    requestId: string,
    sourcePlacement: SpacePlacement,
    channelIds: readonly string[],
  ): Promise<void> {
    if (channelIds.length === 0) return;
    const rows = await this.transaction({
      isolation: "serializable",
      requestId,
      operation: "channel.directory-source",
      placement: {
        spaceId: sourcePlacement.spaceId,
        shardId: sourcePlacement.shardId,
        placementEpoch: sourcePlacement.placementEpoch,
      },
    }, (transaction) => transaction.query<QueryResultRow & {
      channel_id: string;
      space_id: string;
      version: string | number;
      updated_at: string;
    }>({
      name: "channel_space_directory_source_v1",
      text: `SELECT channel_id, space_id, version, updated_at FROM data.channels
        WHERE channel_id = ANY($1::text[]) ORDER BY channel_id LIMIT 10000`,
      values: [channelIds],
      maxRows: 10_000,
    }));
    if (rows.length !== new Set(channelIds).size) {
      throw new SpaceControlError(
        "channel_directory_source_incomplete", 503,
        "Channel directory source is incomplete", true,
      );
    }
    const placementBySpace = new Map<string, SpacePlacement>();
    placementBySpace.set(sourcePlacement.spaceId, sourcePlacement);
    for (const spaceId of new Set(rows.map((row) => row.space_id))) {
      if (!placementBySpace.has(spaceId)) {
        placementBySpace.set(spaceId,
          await this.placement(requestId, "channel.directory-target", spaceId));
      }
    }
    await this.channelDirectory.publishMany({
      requestId,
      operation: "channel.directory-publish",
    }, rows.map((row): ChannelSpaceDirectoryMutation => {
      const current = placementBySpace.get(row.space_id)!;
      return {
        channelId: row.channel_id,
        spaceId: row.space_id,
        shardId: current.shardId,
        placementEpoch: current.placementEpoch,
        entityVersion: Number(row.version),
        state: "active",
        updatedAt: row.updated_at,
      };
    }));
  }

  private async publishCurrentMembershipRoute(
    requestId: string,
    currentPlacement: SpacePlacement,
    userId: string,
  ): Promise<void> {
    const rows = await this.transaction({
      isolation: "serializable",
      requestId,
      operation: "membership.directory-source",
      placement: {
        spaceId: currentPlacement.spaceId,
        shardId: currentPlacement.shardId,
        placementEpoch: currentPlacement.placementEpoch,
      },
    }, (transaction) => transaction.query<QueryResultRow & {
      commit_sequence: string | number;
      head_updated_at: string;
      role: "owner" | "admin" | "member" | "viewer" | null;
      membership_version: string | number | null;
      membership_updated_at: string | null;
    }>({
      name: "user_space_membership_route_source_v1",
      text: `SELECT head.commit_sequence, head.updated_at AS head_updated_at,
          member.role, member.version AS membership_version,
          member.updated_at AS membership_updated_at
        FROM data.space_control_heads head
        LEFT JOIN data.space_members member ON member.space_id = head.space_id
          AND member.user_id = $2
        WHERE head.space_id = $1 LIMIT 1`,
      values: [currentPlacement.spaceId, userId],
      maxRows: 1,
    }));
    const source = rows[0];
    if (!source) throw new SpaceControlError(
      "membership_directory_source_incomplete", 503,
      "Membership directory source is incomplete", true,
    );
    const active = source.role !== null && source.membership_version !== null;
    const routeVersion = Number(source.commit_sequence);
    await this.membershipDirectory.publish({
      requestId,
      operation: "membership.directory-publish",
    }, {
      userId,
      spaceId: currentPlacement.spaceId,
      role: active ? source.role! : "viewer",
      shardId: currentPlacement.shardId,
      placementEpoch: currentPlacement.placementEpoch,
      membershipVersion: active ? Number(source.membership_version) : routeVersion,
      routeVersion,
      state: active ? "active" : "deleted",
      updatedAt: active ? source.membership_updated_at! : source.head_updated_at,
    });
  }

  private async publishEntityRoute(
    requestId: string,
    currentPlacement: SpacePlacement,
    entityKind: EntitySpaceRouteKind,
    entityId: string,
    sourceQuery: { name: string; text: string },
  ): Promise<void> {
    const rows = await this.transaction({
      isolation: "serializable",
      requestId,
      operation: `${entityKind}.directory-source`,
      placement: {
        spaceId: currentPlacement.spaceId,
        shardId: currentPlacement.shardId,
        placementEpoch: currentPlacement.placementEpoch,
      },
    }, (transaction) => transaction.query<QueryResultRow & {
      entity_version: string | number;
      route_version: string | number;
      updated_at: string;
    }>({
      name: sourceQuery.name,
      text: sourceQuery.text,
      values: [currentPlacement.spaceId, entityId],
      maxRows: 1,
    }));
    const source = rows[0];
    if (!source) throw new SpaceControlError(
      "entity_directory_source_incomplete", 503,
      "Entity directory source is incomplete", true,
    );
    await this.entityDirectory.publish({
      requestId,
      operation: `${entityKind}.directory-publish`,
    }, {
      kind: entityKind,
      entityId,
      spaceId: currentPlacement.spaceId,
      shardId: currentPlacement.shardId,
      placementEpoch: currentPlacement.placementEpoch,
      entityVersion: Number(source.entity_version),
      routeVersion: Number(source.route_version),
      state: "active",
      updatedAt: source.updated_at,
    });
  }

  private async publishInviteRoute(
    requestId: string,
    currentPlacement: SpacePlacement,
    tokenHash: string,
  ): Promise<void> {
    return this.publishEntityRoute(requestId, currentPlacement, "space-invite", tokenHash, {
      name: "space_invite_route_source_v1",
      text: `SELECT invite.version AS entity_version, head.commit_sequence AS route_version,
          head.updated_at FROM data.space_invites invite
        JOIN data.space_control_heads head ON head.space_id = invite.space_id
        WHERE invite.space_id = $1 AND invite.token_hash = $2 LIMIT 1`,
    });
  }

  private async publishJoinRequestRoute(
    requestId: string,
    currentPlacement: SpacePlacement,
    joinRequestId: string,
  ): Promise<void> {
    return this.publishEntityRoute(
      requestId, currentPlacement, "space-join-request", joinRequestId, {
        name: "space_join_request_route_source_v1",
        text: `SELECT request.version AS entity_version,
            head.commit_sequence AS route_version, head.updated_at
          FROM data.space_join_requests request
          JOIN data.space_control_heads head ON head.space_id = request.space_id
          WHERE request.space_id = $1 AND request.join_request_id = $2 LIMIT 1`,
      },
    );
  }

  async createSpace(input: CreatePostgresSpace): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const spaceId = bounded(input.spaceId, "spaceId");
    const ownerUserId = bounded(input.ownerUserId, "ownerUserId");
    const name = bounded(input.name, "name");
    const requestDigest = await digest({
      commandId, spaceId, ownerUserId, name, metadata: input.metadata ?? null,
    });
    return this.transaction({ requestId, operation: "space.create" }, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "create-space", requestDigest,
      );
      if (replay) return replay;
      const existing = await transaction.query({
        name: "space_create_conflict_v1",
        text: "SELECT space_id FROM data.spaces WHERE space_id = $1 LIMIT 1",
        values: [spaceId], maxRows: 1,
      });
      if (existing[0]) throw new SpaceControlError("space_exists", 409, "space id already exists");
      const admission = await transaction.query<QueryResultRow & { state: string }>({
        name: "space_shard_admission_v1",
        text: `SELECT state FROM control.postgres_shards
          WHERE shard_id = $1 FOR SHARE`,
        values: [this.shardId], maxRows: 1,
      });
      if (admission[0]?.state !== "active") {
        throw new SpaceControlError(
          "postgres_shard_admission_closed",
          503,
          "PostgreSQL shard is not accepting new Spaces",
          true,
          { shardId: this.shardId, state: admission[0]?.state ?? "missing" },
        );
      }
      const ranks = await transaction.query<QueryResultRow & { value: string }>({
        name: "space_search_rank_allocate_v1",
        text: `SELECT 'pg:' || lpad(nextval('data.search_rank_sequence_v1')::text, 20, '0') AS value`,
        maxRows: 1,
      });
      const searchRankSeq = ranks[0]!.value;
      const now = new Date().toISOString();
      await transaction.query({
        name: "space_placement_create_v1",
        text: `INSERT INTO control.space_placement
          (space_id, shard_id, placement_epoch, state, target_shard_id, plan_class, created_at, updated_at)
          VALUES ($1, $2, 1, 'active', NULL, 'migration-default', $3, $3)`,
        values: [spaceId, this.shardId, now], maxRows: 0,
      });
      await transaction.query({
        name: "space_create_v2",
        text: `INSERT INTO data.spaces
          (space_id, owner_user_id, name, search_rank_sequence, version,
           metadata_json, created_at, updated_at)
          VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, $6)`,
        values: [spaceId, ownerUserId, name, searchRankSeq,
          input.metadata ? JSON.stringify(input.metadata) : null, now], maxRows: 0,
      });
      await insertSpaceMember(transaction, {
        name: "space_owner_create_v1", spaceId, userId: ownerUserId, role: "owner",
        version: 1, email: null, displayName: null, avatarUrl: null,
        createdAt: now, updatedAt: now,
      });
      await transaction.query({
        name: "user_space_directory_create_v1",
        text: `INSERT INTO control.user_space_memberships
          (user_id, space_id, role, membership_version, updated_at)
          VALUES ($1, $2, 'owner', 1, $3)`,
        values: [ownerUserId, spaceId, now], maxRows: 0,
      });
      await transaction.query({
        name: "user_space_membership_route_create_v1",
        text: `INSERT INTO control.user_space_membership_routes
          (user_id,space_id,role,shard_id,placement_epoch,membership_version,
           route_version,state,updated_at)
          VALUES ($1,$2,'owner',$3,1,1,1,'active',$4)`,
        values: [ownerUserId, spaceId, this.shardId, now], maxRows: 0,
      });
      await this.billing.spaceCreated(transaction, { spaceId, now });
      await transaction.query({
        name: "space_control_head_create_v1",
        text: `INSERT INTO data.space_control_heads (space_id, commit_sequence, updated_at)
          VALUES ($1, 1, $2)`,
        values: [spaceId, now], maxRows: 0,
      });
      const result: Record<string, unknown> = {
        id: spaceId, ownerUserId, name,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        version: 1, searchRankSeq, changeSeq: 1, createdAt: now, updatedAt: now,
      };
      await commitSpaceCommand(transaction, {
        name: "space_create_outbox_v1", spaceId, commitSequence: 1, aggregateKind: "space",
        aggregateId: spaceId, commandId, commandKind: "create-space", requestDigest, result, at: now,
      });
      return result;
    });
  }

  async mutateSpace(input: PostgresSpaceMutation): Promise<Record<string, unknown>> {
    const { requestId, commandId, actorUserId, spaceId } = actorCommand(input);
    const at = iso(input.at);
    requireExpectedVersion(input.expectedVersion, 1);
    const requestDigest = await digest(input);
    return this.inSpace(requestId, `space.${input.kind}`, spaceId, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, input.kind, requestDigest,
      );
      if (replay) return replay;
      const spaces = await transaction.query<SpaceRow & {
        version: string | number; search_rank_sequence: string;
      }>({
        name: "space_mutation_lock_v2",
        text: `SELECT space_id,owner_user_id,name,metadata_json,version,
            search_rank_sequence,created_at,updated_at
          FROM data.spaces WHERE space_id = $1 FOR UPDATE`,
        values: [spaceId], maxRows: 1,
      });
      const current = requireSpaceRow(spaces);
      if (input.kind === "space_delete") {
        // Its owner asking again gets the scheduled deletion back, so a client
        // retry can re-arm the purge clock without a second mutation.
        const scheduled = await lockSpaceDeletion(transaction, spaceId);
        if (scheduled?.state === "scheduled" && scheduled.owner_user_id === actorUserId) {
          return {
            commandId, kind: input.kind, entityId: spaceId, entityVersion: Number(current.version),
            reused: true, projectionMutations: [], recipientChanges: [], stopTargets: [], instancesKilled: 0,
            deletion: serializeSpaceDeletion(scheduled),
          };
        }
      }
      const expectedVersion = input.expectedVersion ?? Number(current.version);
      if (Number(current.version) !== expectedVersion) {
        throw new SpaceControlError("conflict", 409, "Space version conflict");
      }
      const actors = await transaction.query<QueryResultRow & { role: string }>({
        name: "space_mutation_actor_v1",
        text: "SELECT role FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
        values: [spaceId, actorUserId], maxRows: 1,
      });
      const role = actors[0]?.role;
      if (input.kind === "space_delete" ? role !== "owner" : role !== "owner" && role !== "admin") {
        throw new SpaceControlError(
          "forbidden", 403, input.kind === "space_delete" ? "Space owner required" : "Space admin required",
        );
      }
      const nextVersion = expectedVersion + 1;
      const projectionMutations = [{
        entityKind: "space", entityId: spaceId, entityVersion: nextVersion,
        visibilityScopeId: `space:${spaceId}`,
        operation: input.kind === "space_delete" ? "tombstone" : "upsert",
        searchRankSeq: current.search_rank_sequence,
      }];
      if (input.kind === "space_update") {
        const name = input.name === undefined ? current.name : bounded(input.name, "name", 200);
        const updated = await transaction.query({
          name: "space_update_v2",
          text: `UPDATE data.spaces SET name=$2,metadata_json=$3::jsonb,
              version=$4,updated_at=$5 WHERE space_id=$1 AND version=$6 RETURNING space_id`,
          values: [spaceId, name,
            input.metadata === undefined
              ? current.metadata_json === null ? null : JSON.stringify(current.metadata_json)
              : JSON.stringify(input.metadata),
            nextVersion, at, expectedVersion],
          maxRows: 1,
        });
        if (!updated[0]) throw new SpaceControlError("conflict", 409, "Space changed");
      } else {
        rejectBilling(await this.billing.spaceDeletion(transaction, { spaceId, now: at }));
        const advanced = await transaction.query({
          name: "space_delete_advance_v1",
          text: `UPDATE data.spaces SET version=$2, updated_at=$3
            WHERE space_id=$1 AND version=$4 RETURNING space_id`,
          values: [spaceId, nextVersion, at, expectedVersion], maxRows: 1,
        });
        if (!advanced[0]) throw new SpaceControlError("conflict", 409, "Space changed");
      }
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_mutation_head_v1", spaceId, at,
      });
      const result: Record<string, unknown> = {
        commandId, kind: input.kind, entityId: spaceId, entityVersion: nextVersion,
        reused: false, projectionMutations, recipientChanges: [],
      };
      if (input.kind === "space_delete") {
        const { deletion, members } = await scheduleSpaceDeletion(transaction, {
          spaceId, spaceName: current.name, ownerUserId: actorUserId, at, commitSequence,
        });
        const channels = await transaction.query<QueryResultRow & { channel_id: string }>({
          name: "space_delete_channels_v1",
          text: `SELECT channel_id FROM data.channels WHERE space_id=$1
            ORDER BY channel_id LIMIT ${CHANNEL_TREE_MAX}`,
          values: [spaceId], maxRows: CHANNEL_TREE_MAX,
        });
        if (channels.length >= CHANNEL_TREE_MAX) {
          throw new SpaceControlError("conflict", 409, "Space has too many Channels to delete at once");
        }
        const stopped = await terminalizeArchivedChannelTree(
          transaction, channels.map((row) => row.channel_id), at,
        );
        result.deletion = deletion;
        result.stopTargets = stopped.archiveStopTargets;
        result.instancesKilled = stopped.instancesKilled;
        result.recipientChanges = members.map((member) => ({
          userId: member.userId, visibilityScopeId: `space:${spaceId}`, change: "revoked",
        }));
      }
      await commitSpaceCommand(transaction, {
        name: "space_mutation_outbox_v1", spaceId, commitSequence, aggregateKind: "space",
        aggregateId: spaceId, commandId, commandKind: input.kind, requestDigest, result, at,
      });
      return result;
    });
  }

  /** The owner's restore of a Space whose deletion has not started purging. */
  async restoreSpace(input: {
    requestId: string; commandId: string; actorUserId: string; spaceId: string; at: string;
  }): Promise<Record<string, unknown>> {
    const { requestId, commandId, actorUserId, spaceId } = actorCommand(input);
    const at = iso(input.at);
    // A purged Space has no placement left; to its owner it is simply gone.
    const placement = await this.placement(requestId, "space.space_restore", spaceId).catch((error: unknown) => {
      if (missingPlacement(error)) throw new SpaceControlError("not_found", 404, "Space not found");
      throw error;
    });
    const requestDigest = await digest(input);
    return this.transaction({
      isolation: "serializable",
      requestId,
      operation: "space.space_restore",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "space_restore", requestDigest,
      );
      if (replay) return replay;
      const deletion = await lockSpaceDeletion(transaction, spaceId);
      // Only the owner learns that a deleted Space exists.
      if (!deletion || deletion.owner_user_id !== actorUserId) {
        throw new SpaceControlError("not_found", 404, "Space not found");
      }
      if (deletion.state !== "scheduled") {
        throw new SpaceControlError("space_purge_started", 409, "Space deletion has already started");
      }
      const spaces = await transaction.query<QueryResultRow & {
        version: string | number; search_rank_sequence: string;
      }>({
        name: "space_restore_lock_v1",
        text: "SELECT version,search_rank_sequence FROM data.spaces WHERE space_id=$1 FOR UPDATE",
        values: [spaceId], maxRows: 1,
      });
      const current = requireSpaceRow(spaces);
      const nextVersion = Number(current.version) + 1;
      await transaction.query({
        name: "space_restore_advance_v1",
        text: "UPDATE data.spaces SET version=$2, updated_at=$3 WHERE space_id=$1",
        values: [spaceId, nextVersion, at], maxRows: 0,
      });
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_restore_head_v1", spaceId, at,
      });
      const members = await restoreSpaceDeletion(transaction, {
        deletion, at, commitSequence,
        placement: { shardId: placement.shardId, placementEpoch: placement.placementEpoch },
      });
      const result: Record<string, unknown> = {
        commandId, kind: "space_restore", entityId: spaceId, entityVersion: nextVersion,
        reused: false,
        projectionMutations: [{
          entityKind: "space", entityId: spaceId, entityVersion: nextVersion,
          visibilityScopeId: `space:${spaceId}`, operation: "upsert",
          searchRankSeq: current.search_rank_sequence,
        }],
        recipientChanges: members.map((member) => ({
          userId: member.userId, visibilityScopeId: `space:${spaceId}`, change: "granted",
        })),
      };
      await commitSpaceCommand(transaction, {
        name: "space_mutation_outbox_v1", spaceId, commitSequence, aggregateKind: "space",
        aggregateId: spaceId, commandId, commandKind: "space_restore", requestDigest, result, at,
      });
      return result;
    });
  }

  /** Spaces this user deleted that they can still restore. */
  async listSpaceDeletions(input: {
    requestId: string; ownerUserId: string;
  }): Promise<Record<string, unknown>[]> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const ownerUserId = bounded(input.ownerUserId, "ownerUserId");
    return this.transaction({ requestId, operation: "space.deletions.list" },
      (transaction) => listScheduledSpaceDeletions(transaction, ownerUserId));
  }

  /**
   * One bounded step of a due Space purge. `objects` asks the caller to delete
   * those R2 keys and report back through {@link recordSpacePurgeObjects}.
   */
  async purgeSpaceStep(input: { requestId: string; spaceId: string; now: string }): Promise<SpacePurgeStep> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const spaceId = bounded(input.spaceId, "spaceId");
    const now = iso(input.now);
    const context = { isolation: "serializable" as const, requestId, operation: "space.purge" };
    const placement = await this.placements.resolve({ requestId, operation: "space.purge.placement" }, spaceId)
      .catch((error: unknown) => {
        if (missingPlacement(error)) return null;
        throw error;
      });
    if (!placement) {
      // Only a completed purge removes the placement; anything else is not ours to touch.
      const deletion = await this.transaction(context, (transaction) => readSpaceDeletion(transaction, spaceId));
      if (!deletion) return { status: "absent" };
      if (deletion.state === "completed") return { status: "completed", deletion };
      throw new SpaceControlError("space_placement_unavailable", 503, "Space placement is unavailable", true);
    }
    if (placement.state !== "active" || placement.targetShardId !== null) {
      throw new SpaceControlError("space_placement_unavailable", 503, "Space placement is not writable", true);
    }
    const fenced = { ...context, placement: {
      spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch,
    } };
    const step = await this.transaction(fenced, (transaction) => nextSpacePurgeStep(transaction, { spaceId, now }));
    if (step.status !== "finalize") return step;
    const completed = await this.transaction(fenced, (transaction) => finalizeSpacePurge(transaction, { spaceId, now }));
    if (!completed) return step;
    // The finalizing transaction removed the placement; no hint may outlive it.
    this.database.placementHints?.forget(spaceId);
    return { status: "completed", deletion: completed };
  }

  async recordSpacePurgeObjects(input: {
    requestId: string; spaceId: string; cursor: string; exhausted: boolean; deleted: number; now: string;
  }): Promise<boolean> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const spaceId = bounded(input.spaceId, "spaceId");
    if (!Number.isSafeInteger(input.deleted) || input.deleted < 0) {
      throw new SpaceControlError("invalid_command", 400, "deleted count is invalid");
    }
    return this.inSpace(requestId, "space.purge.objects", spaceId, (transaction) => recordSpacePurgeObjects(transaction, {
      spaceId, cursor: input.cursor === "" ? "" : bounded(input.cursor, "cursor", 2000),
      exhausted: input.exhausted,
      deleted: input.deleted, now: iso(input.now),
    }));
  }

  async updateSpaceMemberCreationPolicy(
    input: UpdatePostgresSpaceMemberCreationPolicy,
  ): Promise<Record<string, unknown>> {
    const { requestId, commandId, actorUserId, spaceId } = actorCommand(input);
    const at = iso(input.at);
    requireExpectedVersion(input.expectedVersion, 0);
    if (input.agentCreation === undefined && input.automationCreation === undefined) {
      throw new SpaceControlError("invalid_command", 400, "A member creation policy change is required");
    }
    const requestDigest = await digest(input);
    return this.inSpace(requestId, "membership.creation-policy", spaceId, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "space_member_creation_policy_update", requestDigest,
      );
      if (replay) return replay;
      await requireSpaceAdmin(transaction, "space_member_policy_admin_v1", spaceId, actorUserId);
      const policies = await transaction.query<QueryResultRow & {
        agent_creation_policy: "members" | "admins";
        automation_creation_policy: "members" | "admins";
        version: string | number;
      }>({
        name: "space_member_policy_lock_v2",
        text: `SELECT agent_creation_policy,automation_creation_policy,version
          FROM data.space_member_creation_policies WHERE space_id=$1 FOR UPDATE`,
        values: [spaceId], maxRows: 1,
      });
      const current = policies[0];
      const expectedVersion = input.expectedVersion ?? Number(current?.version ?? 0);
      if ((!current && expectedVersion !== 0) ||
          (current && Number(current.version) !== expectedVersion)) {
        throw new SpaceControlError("conflict", 409, "Member creation policy version conflict");
      }
      const agentCreation = input.agentCreation ??
        current?.agent_creation_policy ?? "members";
      const automationCreation = input.automationCreation ??
        current?.automation_creation_policy ?? "members";
      if (current && agentCreation === current.agent_creation_policy &&
          automationCreation === current.automation_creation_policy) {
        throw new SpaceControlError("conflict", 409, "Member creation policy does not change");
      }
      const nextVersion = expectedVersion + 1;
      const written = await transaction.query({
        name: "space_member_policy_upsert_v2",
        text: `INSERT INTO data.space_member_creation_policies
          (space_id,agent_creation_policy,automation_creation_policy,version,
           updated_by_user_id,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (space_id) DO UPDATE SET
            agent_creation_policy=EXCLUDED.agent_creation_policy,
            automation_creation_policy=EXCLUDED.automation_creation_policy,
            version=EXCLUDED.version,updated_by_user_id=EXCLUDED.updated_by_user_id,
            updated_at=EXCLUDED.updated_at
          WHERE data.space_member_creation_policies.version=$7 RETURNING space_id`,
        values: [spaceId, agentCreation, automationCreation, nextVersion,
          actorUserId, at, expectedVersion], maxRows: 1,
      });
      if (!written[0]) throw new SpaceControlError("conflict", 409, "Member creation policy changed");
      const spaces = await transaction.query<QueryResultRow & { version: string | number }>({
        name: "space_member_policy_space_advance_v1",
        text: "UPDATE data.spaces SET version=version+1,updated_at=$2 WHERE space_id=$1 RETURNING version",
        values: [spaceId, at], maxRows: 1,
      });
      if (!spaces[0]) throw new SpaceControlError("not_found", 404, "Space not found");
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_member_policy_head_v1", spaceId, at,
      });
      const result: Record<string, unknown> = {
        commandId, kind: "space_member_creation_policy_update", entityId: spaceId,
        entityVersion: nextVersion, reused: false,
        projectionMutations: [{ entityKind: "space", entityId: spaceId,
          entityVersion: Number(spaces[0].version), visibilityScopeId: `space:${spaceId}`,
          operation: "upsert" }], recipientChanges: [],
      };
      await commitSpaceCommand(transaction, {
        name: "space_member_policy_outbox_v1", spaceId, commitSequence, aggregateKind: "space",
        aggregateId: spaceId, commandId, commandKind: "space_member_creation_policy_update", requestDigest,
        result, at,
      });
      return result;
    });
  }

  async getSpace(input: {
    requestId: string;
    spaceId: string;
    principal: SpaceControlPrincipal;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, principalId } = principalScope(input);
    return this.inSpace(requestId, "space.get", spaceId, async (transaction) => {
      const rows = await transaction.query<SpaceRow>({
        name: "space_get_v4",
        text: `SELECT s.space_id, s.owner_user_id, s.name, s.metadata_json,
            s.created_at, s.updated_at
          FROM data.spaces s
          WHERE s.space_id = $1 AND (
            ($3 = 'user' AND EXISTS (SELECT 1 FROM data.space_members m
              WHERE m.space_id = s.space_id AND m.user_id = $2))
            OR ($3 = 'agent' AND ${agentInSpacePredicate("s.space_id", "$2")})
          ) LIMIT 1`,
        values: [spaceId, principalId, input.principal.kind], maxRows: 1,
      });
      if (!rows[0]) throw new SpaceControlError("space_not_found", 404, "Space not found");
      return this.hydrateSpaces(transaction, rows,
        input.principal.kind === "user" ? principalId : undefined,
      ).then((spaces) => spaces[0]!);
    });
  }

  async listSpaces(input: {
    requestId: string;
    principal: SpaceControlPrincipal;
    cursor?: string;
    limit?: number;
  }): Promise<{ spaces: Record<string, unknown>[]; cursor: string | null }> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const principalId = bounded(input.principal.id, "principal.id");
    if (input.principal.kind !== "user") {
      throw new SpaceControlError("forbidden", 403, "only users may list Spaces");
    }
    const cursor = input.cursor ? bounded(input.cursor, "cursor", 512) : "";
    const limit = pageLimit(input.limit);
    const routes = await this.membershipDirectory.list({
      requestId, operation: "space.list-directory",
    }, principalId, cursor, limit + 1);
    const page = routes.slice(0, limit);
    const byShard = new Map<string, typeof page>();
    for (const route of page) {
      const current = byShard.get(route.shardId) ?? [];
      byShard.set(route.shardId, [...current, route]);
    }
    const hydrated = (await Promise.all([...byShard.values()].map(async (group) => {
      const anchor = group[0]!;
      return this.transaction({
      isolation: "serializable",
        requestId,
        operation: "space.list-shard",
        placement: {
          spaceId: anchor.spaceId,
          shardId: anchor.shardId,
          placementEpoch: anchor.placementEpoch,
        },
      }, async (transaction) => {
        const rows = await transaction.query<SpaceRow>({
          name: "space_list_shard_v2",
          text: `SELECT space.space_id, space.owner_user_id, space.name,
              space.metadata_json, space.created_at, space.updated_at
            FROM data.spaces space
            JOIN data.space_members member ON member.space_id = space.space_id
            WHERE member.user_id = $1 AND space.space_id = ANY($2::text[])
            ORDER BY space.space_id LIMIT $3`,
          values: [principalId, group.map((route) => route.spaceId), group.length],
          maxRows: group.length,
        });
        return this.hydrateSpaces(transaction, rows, principalId);
      });
    }))).flat();
    const bySpace = new Map(hydrated.map((space) => [String(space.id), space]));
    if (bySpace.size !== page.length) throw new SpaceControlError(
      "space_directory_inconsistent", 503, "Space directory is inconsistent", true,
    );
    return {
      spaces: page.map((route) => bySpace.get(route.spaceId)!),
      cursor: routes.length > limit ? page.at(-1)?.spaceId ?? null : null,
    };
  }

  async getSpaceManagementConfig(input: {
    requestId: string;
    spaceId: string;
    principal: SpaceControlPrincipal;
  }): Promise<{ managementAgent: Record<string, unknown>; version: number }> {
    const { requestId, spaceId, principalId } = userScope(
      input, "only users may read Space management config",
    );
    return this.inSpace(requestId, "space.management-config.get", spaceId, async (transaction) => {
      const memberships = await transaction.query({
        name: "space_management_config_member_v1",
        text: "SELECT user_id FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
        values: [spaceId, principalId], maxRows: 1,
      });
      if (!memberships[0]) throw new SpaceControlError("space_not_found", 404, "Space not found");
      const rows = await transaction.query<QueryResultRow & {
        config_json: Record<string, unknown>; version: string | number;
      }>({
        name: "space_management_config_get_v1",
        text: `SELECT config_json, version FROM data.space_management_configs
          WHERE space_id = $1 LIMIT 1`,
        values: [spaceId], maxRows: 1,
      });
      const version = Number(rows[0]?.version ?? 0);
      const stored = rows[0]?.config_json ?? {
        enabled: false,
        sideEffectsEnabled: true,
        identityName: "xMatrix",
        defaultChannelVisibility: "management-visible",
      };
      return { managementAgent: { ...withoutRetiredManagementConfig(stored), configVersion: version }, version };
    });
  }

  async updateSpaceManagementConfig(
    input: UpdatePostgresSpaceManagementConfig,
  ): Promise<Record<string, unknown>> {
    const { requestId, commandId, actorUserId, spaceId } = actorCommand(input);
    const allowed = new Set([
      "enabled", "sideEffectsEnabled", "prompt",
      "managementChannelId", "defaultChannelVisibility",
    ]);
    if (Object.keys(input.patch).some((key) => !allowed.has(key)) ||
        (input.expectedVersion !== undefined &&
          (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0))) {
      throw new SpaceControlError("invalid_management_config", 400, "management config is invalid");
    }
    for (const key of ["enabled", "sideEffectsEnabled"] as const) {
      if (input.patch[key] !== undefined && typeof input.patch[key] !== "boolean") {
        throw new SpaceControlError("invalid_management_config", 400, `${key} must be a boolean`);
      }
    }
    for (const key of ["prompt", "managementChannelId"] as const) {
      const value = input.patch[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new SpaceControlError(
          "invalid_management_config", 400, `${key} must be a string or null`,
        );
      }
    }
    if (typeof input.patch.prompt === "string") {
      const error = parseManagementPrompt(input.patch.prompt).error;
      if (error) throw new SpaceControlError("invalid_management_prompt", 400, error);
    }
    if (input.patch.defaultChannelVisibility !== undefined &&
        !["management-visible", "metadata-only", "excluded"]
          .includes(String(input.patch.defaultChannelVisibility))) {
      throw new SpaceControlError(
        "invalid_management_config", 400, "defaultChannelVisibility is invalid",
      );
    }
    const requestDigest = await digest(input);
    const now = new Date().toISOString();
    return this.inSpace(requestId, "space.management-config.update", spaceId, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "update-space-management-config", requestDigest,
      );
      if (replay) return replay;
      await requireSpaceAdmin(transaction, "space_management_config_admin_v1", spaceId, actorUserId);
      const rows = await transaction.query<QueryResultRow & {
        config_json: Record<string, unknown>; version: string | number;
      }>({
        name: "space_management_config_lock_v1",
        text: `SELECT config_json, version FROM data.space_management_configs
          WHERE space_id = $1 FOR UPDATE`,
        values: [spaceId], maxRows: 1,
      });
      const currentVersion = Number(rows[0]?.version ?? 0);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new SpaceControlError(
          "management_config_version_conflict", 409,
          `management config is at version ${currentVersion}; re-read it and retry`,
        );
      }
      const next: Record<string, unknown> = {
        enabled: false,
        sideEffectsEnabled: true,
        defaultChannelVisibility: "management-visible",
        ...withoutRetiredManagementConfig(rows[0]?.config_json ?? {}),
        ...input.patch,
        identityName: "xMatrix",
        updatedAt: now,
        updatedBy: actorUserId,
      };
      delete next.configVersion;
      if (next.prompt === null || typeof next.prompt === "string" && !next.prompt.trim()) delete next.prompt;
      if (next.managementChannelId === null || next.managementChannelId === "") delete next.managementChannelId;
      else if (next.managementChannelId !== undefined) next.managementChannelId = bounded(next.managementChannelId, "managementChannelId", 120);
      if (next.managementChannelId) {
        const channels = await transaction.query({
          name: "space_management_config_channel_v1",
          text: `SELECT channel_id FROM data.channels WHERE channel_id = $1 AND space_id = $2
            LIMIT 1`,
          values: [next.managementChannelId, spaceId], maxRows: 1,
        });
        if (!channels[0]) throw new SpaceControlError(
          "invalid_management_channel", 400,
          "managementChannelId must reference an active Channel in this Space",
        );
      }
      const version = currentVersion + 1;
      await transaction.query({
        name: "space_management_config_upsert_v1",
        text: `INSERT INTO data.space_management_configs
          (space_id, config_json, version, updated_at, updated_by_user_id)
          VALUES ($1,$2::jsonb,$3,$4,$5) ON CONFLICT (space_id) DO UPDATE SET
            config_json = EXCLUDED.config_json, version = EXCLUDED.version,
            updated_at = EXCLUDED.updated_at, updated_by_user_id = EXCLUDED.updated_by_user_id`,
        values: [spaceId, JSON.stringify(next), version, now, actorUserId], maxRows: 0,
      });
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_management_config_head_v1", spaceId, at: now,
      });
      const result = { managementAgent: { ...next, configVersion: version }, version };
      await commitSpaceCommand(transaction, {
        name: "space_management_config_outbox_v1", spaceId, commitSequence, aggregateKind: "space",
        aggregateId: spaceId, commandId, commandKind: "update-space-management-config", requestDigest, result,
        at: now,
      });
      return result;
    });
  }

  private async hydrateSpaces(
    transaction: DatabaseTransaction,
    spaces: readonly SpaceRow[],
    viewerUserId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (spaces.length === 0) return [];
    const ids = spaces.map((space) => space.space_id);
    const members = await transaction.query<MemberRow>({
      name: "space_members_hydrate_v1",
      text: `SELECT m.space_id, m.user_id, m.role, m.email, m.display_name, m.avatar_url,
          m.created_at, u.name AS profile_name, u.handle AS profile_handle,
          u.image AS profile_avatar_url, u.bio AS profile_bio,
          u.time_zone AS profile_time_zone, u.profile_version
        FROM data.space_members m
        LEFT JOIN control.auth_users u ON u.id = m.user_id
        WHERE m.space_id = ANY($1::text[])
        ORDER BY m.space_id, m.user_id LIMIT 10000`,
      values: [ids], maxRows: 10_000,
    });
    const policies = await transaction.query({
      name: "space_member_policies_hydrate_v2",
      text: `SELECT space_id, agent_creation_policy, automation_creation_policy
        FROM data.space_member_creation_policies WHERE space_id = ANY($1::text[]) LIMIT 200`,
      values: [ids], maxRows: 200,
    });
    const configs = await transaction.query({
      name: "space_management_configs_hydrate_v1",
      text: `SELECT space_id, config_json, version
        FROM data.space_management_configs WHERE space_id = ANY($1::text[]) LIMIT 200`,
      values: [ids], maxRows: 200,
    });
    const pendingCounts = viewerUserId ? await transaction.query<QueryResultRow & {
      space_id: string; pending_join_request_count: string | number;
    }>({
      name: "space_join_request_counts_hydrate_v1",
      text: `SELECT member.space_id,
          COUNT(request.join_request_id) AS pending_join_request_count
        FROM data.space_members member
        LEFT JOIN data.space_join_requests request ON request.space_id = member.space_id
          AND request.status = 'pending'
        WHERE member.user_id = $1 AND member.role IN ('owner','admin')
          AND member.space_id = ANY($2::text[])
        GROUP BY member.space_id ORDER BY member.space_id LIMIT $3`,
      values: [viewerUserId, ids, ids.length], maxRows: ids.length,
    }) : [];
    const pendingCountBySpace = new Map(pendingCounts.map((row) => [
      row.space_id, Number(row.pending_join_request_count),
    ]));
    return spaces.map((space) => serializeSpace(
      space,
      members.filter((member) => member.space_id === space.space_id),
      policies.find((policy) => policy.space_id === space.space_id),
      configs.find((config) => config.space_id === space.space_id),
      pendingCountBySpace.get(space.space_id),
    ));
  }

  async createChannel(input: CreatePostgresChannel): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const channelId = bounded(input.channelId, "channelId");
    const spaceId = bounded(input.spaceId, "spaceId");
    const name = bounded(input.name, "name");
    const principalId = bounded(input.principal.id, "principal.id");
    if (input.principal.kind !== "user") {
      throw new SpaceControlError("forbidden", 403, "only a Space member may create a channel");
    }
    // Direct messages are retired: someone is reached in a conversation.
    if (input.metadata?.kind === "direct") {
      throw new SpaceControlError("direct_conversation_retired", 400, "direct conversations are retired");
    }
    const requestedMetadata = input.metadata;
    const creatorAgentInstanceId = input.creatorAgentInstanceId === undefined
      ? undefined : bounded(input.creatorAgentInstanceId, "creatorAgentInstanceId");
    const requestDigest = await digest({
      commandId, channelId, spaceId, parentChannelId: null,
      name, mode: input.mode, principal: input.principal, metadata: requestedMetadata ?? null,
      threadRootAuthority: null, threadRootPayloadBundleBase64: null,
      ...(creatorAgentInstanceId ? { creatorAgentInstanceId } : {}),
    });
    const placement = await this.placement(requestId, "channel.create", spaceId);
    const result = await this.inSpace(requestId, "channel.create", placement, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "create-channel", requestDigest,
      );
      if (replay) return replay;
      // These checks share the transaction snapshot and need no intermediate
      // result. Read them together to avoid three sequential database trips.
      const checks = await transaction.query<QueryResultRow & {
        role: string; space_id: string | null; channel_exists: boolean;
      }>({
        name: "channel_create_checks_v2",
        text: `SELECT m.role, s.space_id,
            EXISTS (SELECT 1 FROM data.channels WHERE channel_id = $3) AS channel_exists
          FROM data.space_members m
          LEFT JOIN data.spaces s ON s.space_id = m.space_id
          WHERE m.space_id = $1 AND m.user_id = $2 LIMIT 1`,
        values: [spaceId, principalId, channelId], maxRows: 1,
      });
      const check = checks[0];
      if (!check) {
        throw new SpaceControlError("forbidden", 403, "only a Space member may create a channel");
      }
      if (!check.space_id) throw new SpaceControlError("space_not_found", 404, "Space not found");
      if (check.channel_exists) throw new SpaceControlError("channel_exists", 409, "channel id already exists");
      // A participant's conversation is their intake: the project's triage
      // reads it; nobody else is interrupted (open-project-governance.md §3).
      const participant = check.role === "participant";
      // Whose intake a conversation is, is the Space's fact, never a caller's.
      const { intakeOf: _intakeOf, ...requested } = requestedMetadata ?? {};
      const metadata = { ...requested, xmatrixCreatedByUserId: principalId,
        ...(participant ? { intakeOf: principalId } : {}) };
      const nameKey = channelNameStorageKey(name, channelId);
      const now = new Date().toISOString();
      const inserted = await transaction.query<QueryResultRow & { channel_id: string; search_rank_sequence: string }>({
        name: "channel_create_v4",
        text: `INSERT INTO data.channels
          (channel_id, space_id, name, name_key, mode,
           search_rank_sequence, version, metadata_json, created_at, updated_at, activity_at)
          VALUES ($1, $2, $3, $4, $5,
            'pg:' || lpad(nextval('data.search_rank_sequence_v1')::text, 20, '0'),
            1, $6::jsonb, $7, $7, $7)
          ON CONFLICT DO NOTHING RETURNING channel_id, search_rank_sequence`,
        values: [channelId, spaceId, name, nameKey, input.mode,
          JSON.stringify(metadata), now], maxRows: 1,
      });
      if (!inserted[0]) {
        throw new SpaceControlError("channel_exists", 409, "channel id already exists");
      }
      const searchRankSeq = inserted[0].search_rank_sequence;
      await transaction.query({
        name: "channel_space_directory_create_v1",
        text: `INSERT INTO control.channel_space_directory (channel_id, space_id, updated_at)
          VALUES ($1, $2, $3)`,
        values: [channelId, spaceId, now], maxRows: 0,
      });
      if (input.mode === "closed") {
        await transaction.query({
          name: "channel_access_create_v1",
          text: `INSERT INTO data.channel_access
            (space_id, channel_id, subject_kind, subject_id, grant_version, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 1, $5, $5)`,
          values: [spaceId, channelId, "user", principalId, now], maxRows: 0,
        });
        // An Agent that creates a closed Channel can use it: its Instance is
        // granted with its owner, only while that Instance runs a registered
        // Run of this owner in this Space.
        if (creatorAgentInstanceId) {
          const granted = await transaction.query({
            name: "channel_access_create_agent_v1",
            text: `INSERT INTO data.channel_access
              (space_id, channel_id, subject_kind, subject_id, grant_version, created_at, updated_at)
              SELECT $1, $2, 'agent', i.instance_id, 1, $5, $5 FROM data.instances i
              JOIN data.runs r ON r.run_id=i.run_id
              JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=$1
              WHERE i.instance_id=$3 AND r.owner_user_id=$4 AND r.status IN ('starting','running')
              RETURNING subject_id`,
            values: [spaceId, channelId, creatorAgentInstanceId, principalId, now], maxRows: 1,
          });
          if (!granted[0]) throw new SpaceControlError(
            "forbidden", 403, "the creating Agent Instance is not a live Run of this owner in this Space");
        }
      }
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_control_head_advance_v1", spaceId, at: now,
      });
      const channelRow: ChannelRow = {
        channel_id: channelId, space_id: spaceId,
        name, mode: input.mode, metadata_json: metadata, version: 1,
        created_at: now, updated_at: now,
      };
      const visibleHumanIds = input.mode === "closed"
        ? await this.visibleHumanIds(transaction, channelRow) : [];
      const result: Record<string, unknown> = {
        id: channelId, spaceId, parentChannelId: null, name, mode: input.mode,
        ...(requestedMetadata ? { metadata: requestedMetadata } : {}),
        version: 1, searchRankSeq, changeSeq: commitSequence, createdAt: now, updatedAt: now,
        channel: serializeChannel(channelRow, visibleHumanIds),
      };
      await commitSpaceCommand(transaction, {
        name: "channel_create_outbox_v1", spaceId, commitSequence, aggregateKind: "channel",
        aggregateId: channelId, commandId, commandKind: "create-channel", requestDigest, result, at: now,
      });
      return result;
    });
    await this.channelDirectory.publish({
      requestId,
      operation: "channel.directory-publish",
    }, {
      channelId,
      spaceId,
      shardId: placement.shardId,
      placementEpoch: placement.placementEpoch,
      entityVersion: 1,
      state: "active",
      updatedAt: typeof result.updatedAt === "string" ? result.updatedAt : new Date().toISOString(),
    });
    return result;
  }

  /**
   * Live Agents this principal may see in one Space, from Instance rows.
   * High-frequency activity is not on this read; presence frames fill it.
   */
  async listLiveAgentPresence(input: {
    requestId: string;
    spaceId: string;
    principal: SpaceControlPrincipal;
  }): Promise<Awaited<ReturnType<typeof loadVisibleLiveAgentPresence>>> {
    const { requestId, spaceId } = principalScope(input);
    return this.inSpace(requestId, "channel.live-agents", spaceId, (transaction) =>
      loadVisibleLiveAgentPresence(transaction, spaceId, input.principal));
  }

  async getChannel(input: {
    requestId: string;
    channelId: string;
    spaceId: string;
    principal: SpaceControlPrincipal;
    /** Names the read path for observation; `channel.get` unless a caller narrows it. */
    operation?: `channel.get${string}`;
  }): Promise<Record<string, unknown>> {
    const { requestId, spaceId, principalId } = principalScope(input);
    const channelId = bounded(input.channelId, "channelId");
    return this.inSpace(requestId, input.operation ?? "channel.get", spaceId, async (transaction) => {
      // The shared predicate checks current Space membership and Channel grants
      // in the same statement as the row, without a list cursor or catalog head.
      const rows = await transaction.query<ChannelRow>({
        name: "channel_get_v4",
        text: `SELECT c.channel_id,c.space_id,c.name,c.mode,
            c.metadata_json,c.version,c.created_at,c.updated_at,
            s.owner_user_id AS created_by_fallback,
            COALESCE((SELECT counter.content_revision FROM data.channel_content_counters counter
              WHERE counter.space_id=c.space_id AND counter.channel_id=c.channel_id),0) AS content_revision
          FROM data.channels c JOIN data.spaces s ON s.space_id=c.space_id
          WHERE c.space_id=$1 AND c.channel_id=$2
            AND ${channelCapabilityPredicate({ capability: "catalog_read", channelAlias: "c",
              principalKindSql: "$3", principalIdSql: "$4" })}
          LIMIT 1`,
        values: [spaceId, channelId, input.principal.kind, principalId], maxRows: 1,
      });
      const row = rows[0];
      if (!row) throw new SpaceControlError("channel_not_found", 404, "Channel not found");
      const presence = await loadChannelAgentPresence(transaction, spaceId, [channelId]);
      const channel = serializeChannel(row,
        row.mode === "closed" ? await this.visibleHumanIds(transaction, row) : [],
        presence.get(channelId));
      const members = row.mode === "open" ? await transaction.query<QueryResultRow & { user_id: string }>({
        name: "open_channel_space_members_v1",
        text: `SELECT user_id FROM data.space_members
          WHERE space_id = $1 ORDER BY user_id LIMIT 10000`,
        values: [spaceId], maxRows: 10_000,
      }) : [];
      return { channel, openChannelHumanMemberIdsBySpace: members.length
        ? { [spaceId]: members.map((member) => `user:${member.user_id}`) } : {} };
    });
  }

  async resolveChannelSpaceRoute(
    input: { requestId: string; channelId: string; operation?: `channel.resolve-space${string}` },
  ): Promise<ChannelSpaceRoute> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const channelId = bounded(input.channelId, "channelId");
    const route = await this.channelDirectory.resolve({
      requestId, operation: input.operation ?? "channel.resolve-space",
    }, channelId);
    if (!route) throw new SpaceControlError("channel_not_found", 404, "Channel not found");
    return route;
  }

  async resolveChannelSpaceId(input: {
    requestId: string; channelId: string; operation?: `channel.resolve-space${string}`;
  }): Promise<string> {
    return (await this.resolveChannelSpaceRoute(input)).spaceId;
  }

  /**
   * The Channel's Space and that Space's current placement in one directory
   * read. Fails exactly as `resolveChannelSpaceId` followed by a placement
   * lookup would: an unrouted Channel is not found, and a routed Space without
   * a placement row is a contract failure. It only selects a shard; the reader
   * still takes that shard's placement fence.
   */
  async resolveChannelSpacePlacement(
    input: { requestId: string; channelId: string },
  ): Promise<{ spaceId: string; placement: SpacePlacement }> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const channelId = bounded(input.channelId, "channelId");
    const resolved = await this.channelDirectory.resolveWithPlacement({
      requestId, operation: "channel.resolve-space",
    }, channelId);
    if (!resolved) throw new SpaceControlError("channel_not_found", 404, "Channel not found");
    if (!resolved.placement) throw new DatabaseContractError("Space placement is unavailable");
    return { spaceId: resolved.route.spaceId, placement: resolved.placement };
  }

  async mutateMembership(input: PostgresMembershipMutation): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const actorUserId = bounded(input.actorUserId, "actorUserId");
    const at = iso(input.at);
    requireExpectedVersion(input.expectedVersion, 0);
    const channelId = "channelId" in input ? bounded(input.channelId, "channelId") : null;
    const spaceId = "spaceId" in input
      ? bounded(input.spaceId, "spaceId")
      : await this.resolveChannelSpaceId({ requestId, channelId: channelId! });
    const requestDigest = await digest(input);
    const placement = await this.placement(requestId, `membership.${input.kind}`, spaceId);
    const result = await this.inSpace(requestId, `membership.${input.kind}`, placement, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, input.kind, requestDigest,
      );
      if (replay) return replay;

      let entityId: string;
      let entityVersion: number;
      let projectionMutations: Record<string, unknown>[];
      let recipientChanges: Record<string, unknown>[];

      if (input.kind === "space_member_put" || input.kind === "space_member_remove") {
        const userId = bounded(input.userId, "userId");
        await requireSpaceAdmin(transaction, "space_membership_admin_v1", spaceId, actorUserId);
        const members = await transaction.query<QueryResultRow & {
          role: string; version: string | number;
        }>({
          name: "space_membership_lock_v1",
          text: `SELECT role, version FROM data.space_members
            WHERE space_id = $1 AND user_id = $2 FOR UPDATE`,
          values: [spaceId, userId], maxRows: 1,
        });
        const current = members[0];
        const expectedVersion = input.expectedVersion ?? Number(current?.version ?? 0);
        if (current?.role === "owner") throw new SpaceControlError(
          "forbidden", 403, "owner membership cannot be changed",
        );
        if (input.kind === "space_member_put") {
          if ((!current && expectedVersion !== 0) ||
              (current && Number(current.version) !== expectedVersion)) {
            throw new SpaceControlError("conflict", 409, "membership version conflict");
          }
          const wasBillable = current && !readsOnly(current.role);
          const willBeBillable = !readsOnly(input.role);
          if (!wasBillable && willBeBillable) {
            rejectBilling(await this.billing.seatAdmission(transaction, { spaceId, now: at }));
          }
          entityVersion = expectedVersion + 1;
          if (current) {
            const updated = await transaction.query({
              name: "space_membership_update_v1",
              text: `UPDATE data.space_members SET role = $3,
                  email = COALESCE($4, email), display_name = COALESCE($5, display_name),
                  avatar_url = COALESCE($6, avatar_url), version = $7, updated_at = $8
                WHERE space_id = $1 AND user_id = $2 AND version = $9 RETURNING user_id`,
              values: [spaceId, userId, input.role,
                input.email === undefined ? null : bounded(input.email, "email", 320),
                input.name === undefined ? null : bounded(input.name, "name", 200),
                input.avatarUrl === undefined ? null : bounded(input.avatarUrl, "avatarUrl", 2048),
                entityVersion, at, expectedVersion], maxRows: 1,
            });
            if (!updated[0]) throw new SpaceControlError("conflict", 409, "membership changed");
          } else {
            await insertSpaceMember(transaction, {
              name: "space_membership_insert_v1", spaceId, userId, role: input.role,
              version: 1,
              email: input.email === undefined ? null : bounded(input.email, "email", 320),
              displayName: input.name === undefined ? null : bounded(input.name, "name", 200),
              avatarUrl: input.avatarUrl === undefined ? null
                : bounded(input.avatarUrl, "avatarUrl", 2048),
              createdAt: at, updatedAt: at,
            });
          }
          await transaction.query({
            name: "user_space_membership_upsert_v1",
            text: `INSERT INTO control.user_space_memberships
                (user_id,space_id,role,membership_version,updated_at) VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (user_id,space_id) DO UPDATE SET role = EXCLUDED.role,
                membership_version = EXCLUDED.membership_version, updated_at = EXCLUDED.updated_at`,
            values: [userId, spaceId, input.role, entityVersion, at], maxRows: 0,
          });
          recipientChanges = [{ userId, visibilityScopeId: `space:${spaceId}`,
            change: current ? "entitlement_changed" : "granted" }];
        } else {
          if (!current) throw new SpaceControlError("not_found", 404, "membership not found");
          if (Number(current.version) !== expectedVersion) {
            throw new SpaceControlError("conflict", 409, "membership version conflict");
          }
          await transaction.query({
            name: "space_membership_locale_remove_v1",
            text: "DELETE FROM data.user_space_locale_preferences WHERE space_id = $1 AND user_id = $2",
            values: [spaceId, userId], maxRows: 0,
          });
          const removed = await transaction.query({
            name: "space_membership_remove_v1",
            text: `DELETE FROM data.space_members WHERE space_id = $1 AND user_id = $2
              AND version = $3 RETURNING user_id`,
            values: [spaceId, userId, expectedVersion], maxRows: 1,
          });
          if (!removed[0]) throw new SpaceControlError("conflict", 409, "membership changed");
          await transaction.query({
            name: "user_space_membership_remove_v1",
            text: "DELETE FROM control.user_space_memberships WHERE user_id = $1 AND space_id = $2",
            values: [userId, spaceId], maxRows: 0,
          });
          entityVersion = expectedVersion + 1;
          recipientChanges = [{ userId, visibilityScopeId: `space:${spaceId}`, change: "revoked" }];
        }
        const spaces = await transaction.query<QueryResultRow & { version: string | number }>({
          name: "space_membership_space_advance_v1",
          text: `UPDATE data.spaces SET version = version + 1, updated_at = $2
            WHERE space_id = $1 RETURNING version`,
          values: [spaceId, at], maxRows: 1,
        });
        if (!spaces[0]) throw new SpaceControlError("not_found", 404, "Space not found");
        projectionMutations = [{ entityKind: "space", entityId: spaceId,
          entityVersion: Number(spaces[0].version), visibilityScopeId: `space:${spaceId}`,
          operation: "upsert" }];
        entityId = `${spaceId}:${userId}`;
      } else {
        const subjectId = bounded(input.subjectId, "subjectId");
        const channels = await transaction.query<ChannelRow>({
          name: "channel_access_channel_lock_v2",
          text: `SELECT channel_id,space_id,name,mode,
              metadata_json,version,search_rank_sequence,created_at,updated_at
            FROM data.channels WHERE channel_id = $1 FOR UPDATE`,
          values: [channelId], maxRows: 1,
        });
        const channel = channels[0];
        if (!channel) throw new SpaceControlError("not_found", 404, "channel not found");
        const selfRemove = input.kind === "channel_access_remove" &&
          input.subjectKind === "user" && subjectId === actorUserId;
        const actors = await transaction.query<QueryResultRow & { role: string }>({
          name: "channel_access_actor_v1",
          text: "SELECT role FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
          values: [spaceId, actorUserId], maxRows: 1,
        });
        if (!actors[0] || (!selfRemove && !["owner", "admin"].includes(actors[0].role))) {
          throw new SpaceControlError("forbidden", 403, selfRemove
            ? "space membership required" : "Space admin required");
        }
        if (channel.mode !== "closed") throw new SpaceControlError(
          "conflict", 409, "ACL mutations require a closed channel",
        );
        const subjects = await transaction.query({
          name: "channel_access_subject_v2",
          text: input.subjectKind === "user"
            ? "SELECT user_id FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1"
            : `SELECT 1 AS present WHERE ${agentInSpacePredicate("$1", "$2")}`,
          values: [spaceId, subjectId], maxRows: 1,
        });
        if (!subjects[0]) throw new SpaceControlError("not_found", 404,
          input.subjectKind === "user" ? "subject is not a Space member" : "Agent not found in Space");
        const grants = await transaction.query<QueryResultRow & { grant_version: string | number }>({
          name: "channel_access_lock_v1",
          text: `SELECT grant_version FROM data.channel_access WHERE space_id = $1
            AND channel_id = $2 AND subject_kind = $3 AND subject_id = $4 FOR UPDATE`,
          values: [spaceId, channelId, input.subjectKind, subjectId], maxRows: 1,
        });
        const grant = grants[0];
        const expectedVersion = input.expectedVersion ?? Number(grant?.grant_version ?? 0);
        entityVersion = expectedVersion + 1;
        if (input.kind === "channel_access_put") {
          if ((!grant && expectedVersion !== 0) ||
              (grant && Number(grant.grant_version) !== expectedVersion)) {
            throw new SpaceControlError("conflict", 409, "grant version conflict");
          }
          if (grant) await transaction.query({
            name: "channel_access_update_v1",
            text: `UPDATE data.channel_access SET grant_version = $5, updated_at = $6
              WHERE space_id = $1 AND channel_id = $2 AND subject_kind = $3 AND subject_id = $4`,
            values: [spaceId, channelId, input.subjectKind, subjectId, entityVersion, at], maxRows: 0,
          });
          else await transaction.query({
            name: "channel_access_insert_v1",
            text: `INSERT INTO data.channel_access
              (space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
              VALUES ($1,$2,$3,$4,1,$5,$5)`,
            values: [spaceId, channelId, input.subjectKind, subjectId, at], maxRows: 0,
          });
        } else {
          if (!grant) throw new SpaceControlError("not_found", 404, "grant not found");
          if (Number(grant.grant_version) !== expectedVersion) {
            throw new SpaceControlError("conflict", 409, "grant version conflict");
          }
          await transaction.query({
            name: "channel_access_remove_v1",
            text: `DELETE FROM data.channel_access WHERE space_id = $1 AND channel_id = $2
              AND subject_kind = $3 AND subject_id = $4 AND grant_version = $5`,
            values: [spaceId, channelId, input.subjectKind, subjectId, expectedVersion], maxRows: 0,
          });
        }
        const updated = await transaction.query<QueryResultRow & { version: string | number }>({
          name: "channel_access_channel_advance_v1",
          text: `UPDATE data.channels SET version = version + 1, updated_at = $2,
            activity_at=GREATEST(COALESCE(activity_at,updated_at),$2::timestamptz)
            WHERE channel_id = $1 RETURNING version`,
          values: [channelId, at], maxRows: 1,
        });
        projectionMutations = [projectionMutation(channel, Number(updated[0]!.version), "upsert")];
        recipientChanges = input.subjectKind === "user" ? [{ userId: subjectId,
          visibilityScopeId: `channel:${channelId}`,
          change: input.kind === "channel_access_put" ? "granted" : "revoked" }] : [];
        entityId = `${channelId}:${input.subjectKind}:${subjectId}`;
      }

      const commitSequence = await requiredControlHead(transaction, {
        name: "membership_head_advance_v1", spaceId, at,
      });
      const result: Record<string, unknown> = {
        commandId, kind: input.kind, entityId, entityVersion, reused: false,
        projectionMutations, recipientChanges,
      };
      await commitSpaceCommand(transaction, {
        name: "membership_outbox_v1", spaceId, commitSequence, aggregateKind: "membership",
        aggregateId: entityId, commandId, commandKind: input.kind, requestDigest, result, at,
      });
      return result;
    });
    if (input.kind === "space_member_put" || input.kind === "space_member_remove") {
      await this.publishCurrentMembershipRoute(requestId, placement, bounded(input.userId, "userId"));
    }
    return result;
  }

  async createSpaceInvite(input: CreatePostgresSpaceInvite): Promise<Record<string, unknown>> {
    const { requestId, commandId, actorUserId, spaceId } = actorCommand(input);
    if ((input.expiresInHours !== undefined && (!Number.isSafeInteger(input.expiresInHours) ||
        input.expiresInHours < 1 || input.expiresInHours > 24 * 30)) ||
        (input.maxUses !== null && (!Number.isSafeInteger(input.maxUses) ||
          input.maxUses < 1 || input.maxUses > 10_000))) {
      throw new SpaceControlError("invalid_invite", 400, "invite limits are invalid");
    }
    const requestDigest = await digest(input);
    const now = new Date().toISOString();
    const placement = await this.placement(requestId, "space-invite.create", spaceId);
    const result = await this.inSpace(requestId, "space-invite.create", placement, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "create-space-invite", requestDigest,
      );
      if (replay) return replay;
      const spaces = await transaction.query<QueryResultRow & {
        name: string; owner_user_id: string;
      }>({
        name: "space_invite_space_v2",
        text: "SELECT name, owner_user_id FROM data.spaces WHERE space_id = $1 LIMIT 1",
        values: [spaceId], maxRows: 1,
      });
      const space = spaces[0];
      if (!space) throw new SpaceControlError("space_not_found", 404, "Space not found");
      if (!input.admin) {
        await requireSpaceAdmin(transaction, "space_invite_admin_v1", spaceId, actorUserId);
      }
      const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
      const tokenHash = await sha256Hex(token);
      const inviteId = crypto.randomUUID();
      const createdBy = input.admin ? space.owner_user_id : actorUserId;
      const expiresAt = input.expiresInHours
        ? new Date(Date.parse(now) + input.expiresInHours * 60 * 60_000).toISOString() : null;
      await transaction.query({
        name: "space_invite_insert_v1",
        text: `INSERT INTO data.space_invites
          (invite_id,token_hash,space_id,role,created_by_user_id,status,accepted_by_user_id,
           version,max_uses,use_count,requires_approval,created_at,expires_at,accepted_at)
          VALUES ($1,$2,$3,$4,$5,'active',NULL,1,$6,0,$7,$8,$9,NULL)`,
        values: [inviteId, tokenHash, spaceId, input.role, createdBy, input.maxUses,
          input.requiresApproval, now, expiresAt], maxRows: 0,
      });
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_invite_head_advance_v1", spaceId, at: now,
      });
      const result: Record<string, unknown> = { invite: {
        token, spaceId, spaceName: space.name, role: input.role, createdBy, createdAt: now,
        maxUses: input.maxUses, useCount: 0, requiresApproval: input.requiresApproval,
        ...(expiresAt ? { expiresAt } : {}),
      } };
      await commitSpaceCommand(transaction, {
        name: "space_invite_outbox_v1", spaceId, commitSequence, aggregateKind: "space-invite",
        aggregateId: inviteId,
        payload: { inviteId, spaceId, role: input.role, createdBy, expiresAt, maxUses: input.maxUses, requiresApproval: input.requiresApproval },
        commandId, commandKind: "create-space-invite", requestDigest, result, at: now,
      });
      return result;
    });
    const invite = result.invite && typeof result.invite === "object"
      ? result.invite as Record<string, unknown> : null;
    if (typeof invite?.token !== "string") throw new SpaceControlError(
      "entity_directory_source_incomplete", 503,
      "Entity directory source is incomplete", true,
    );
    await this.publishInviteRoute(requestId, placement, await sha256Hex(invite.token));
    return result;
  }

  private async inviteSpace(requestId: string, tokenHash: string, operation: string, name: string) {
    const route = await this.entityDirectory.resolve({ requestId, operation }, "space-invite", tokenHash);
    if (route) return route.spaceId;
    const legacy = await this.transaction({ requestId, operation: `${operation}-legacy` },
      transaction => transaction.query<QueryResultRow & { space_id: string }>({ name,
        text: "SELECT space_id FROM data.space_invites WHERE token_hash = $1 LIMIT 1",
        values: [tokenHash], maxRows: 1,
      }));
    return legacy[0]?.space_id;
  }

  async getSpaceInvite(input: { requestId: string; tokenHash: string }): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const tokenHash = bounded(input.tokenHash, "tokenHash", 64);
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) {
      throw new SpaceControlError("invalid_request", 400, "tokenHash is invalid");
    }
    const spaceId = await this.inviteSpace(requestId, tokenHash, "space-invite.locate", "space_invite_locate_legacy_v1");
    if (!spaceId) throw new SpaceControlError("invite_not_found", 404, "Invite not found or expired");
    return this.inSpace(requestId, "space-invite.get", spaceId, async (transaction) => {
      const rows = await transaction.query<QueryResultRow>({
        name: "space_invite_get_v1",
        text: `SELECT i.*, s.name AS space_name FROM data.space_invites i
          JOIN data.spaces s ON s.space_id = i.space_id
          WHERE i.token_hash = $1 AND i.status = 'active'
            AND (i.expires_at IS NULL OR i.expires_at > clock_timestamp()) LIMIT 1`,
        values: [tokenHash], maxRows: 1,
      });
      const row = rows[0];
      if (!row) throw new SpaceControlError("invite_not_found", 404, "Invite not found or expired");
      return { invite: {
        spaceId: row.space_id, spaceName: row.space_name, role: row.role,
        createdBy: row.created_by_user_id, createdAt: iso(row.created_at as Date | string),
        maxUses: row.max_uses === null ? null : Number(row.max_uses),
        useCount: Number(row.use_count), requiresApproval: row.requires_approval === true,
        ...(row.expires_at ? { expiresAt: iso(row.expires_at as Date | string) } : {}),
      } };
    });
  }

  async acceptSpaceInvite(input: {
    requestId: string; commandId: string; tokenHash: string; actorUserId: string;
    email?: string; name?: string; avatarUrl?: string;
  }): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const tokenHash = bounded(input.tokenHash, "tokenHash", 64);
    const actorUserId = bounded(input.actorUserId, "actorUserId");
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) throw new SpaceControlError(
      "invalid_request", 400, "tokenHash is invalid",
    );
    const spaceId = await this.inviteSpace(requestId, tokenHash, "space-invite.locate-for-accept", "space_invite_accept_locate_legacy_v1");
    if (!spaceId) throw new SpaceControlError("invite_not_found", 404, "Invite not found");
    const requestDigest = await digest(input);
    const now = new Date().toISOString();
    const placement = await this.placement(requestId, "space-invite.accept", spaceId);
    const result = await this.inSpace(requestId, "space-invite.accept", placement, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "accept-space-invite", requestDigest,
      );
      if (replay) return replay;
      const invites = await transaction.query<QueryResultRow>({
        name: "space_invite_accept_lock_v1",
        text: "SELECT * FROM data.space_invites WHERE token_hash = $1 FOR UPDATE",
        values: [tokenHash], maxRows: 1,
      });
      const invite = invites[0];
      if (!invite) throw new SpaceControlError("invite_not_found", 404, "Invite not found");
      const expiresAt = invite.expires_at
        ? new Date(invite.expires_at as Date | string).getTime() : null;
      const maxUses = invite.max_uses === null ? null : Number(invite.max_uses);
      const useCount = Number(invite.use_count ?? 0);
      if (expiresAt !== null && expiresAt <= Date.parse(now)) throw new SpaceControlError(
        "invite_expired", 410, "This invite link has expired",
      );
      if (invite.status === "expired") throw new SpaceControlError(
        "invite_expired", 410, "This invite link is no longer active",
      );
      if ((maxUses !== null && useCount >= maxUses) ||
          (maxUses === null && invite.status !== "active" &&
            invite.accepted_by_user_id !== actorUserId)) {
        throw new SpaceControlError("invite_exhausted", 410, "This invite link has been used up");
      }
      const members = await transaction.query<QueryResultRow & {
        role: string; version: string | number;
      }>({
        name: "space_invite_accept_member_lock_v1",
        text: `SELECT role, version FROM data.space_members
          WHERE space_id = $1 AND user_id = $2 FOR UPDATE`,
        values: [spaceId, actorUserId], maxRows: 1,
      });
      const member = members[0];
      let result: Record<string, unknown>;
      if (invite.requires_approval === true && !member) {
        const joinRequestId = `join:${spaceId}:${actorUserId}`.slice(0, 300);
        await transaction.query({
          name: "space_join_request_upsert_v1",
          text: `INSERT INTO data.space_join_requests
            (join_request_id,space_id,invite_id,user_id,role,status,email,display_name,
             avatar_url,decided_by_user_id,version,created_at,decided_at)
            VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,NULL,1,$9,NULL)
            ON CONFLICT (join_request_id) DO UPDATE SET invite_id = EXCLUDED.invite_id,
              role = EXCLUDED.role, status = 'pending', email = EXCLUDED.email,
              display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url,
              decided_by_user_id = NULL, decided_at = NULL,
              version = data.space_join_requests.version + 1, created_at = EXCLUDED.created_at`,
          values: [joinRequestId, spaceId, invite.invite_id, actorUserId, invite.role,
            input.email ?? null, input.name ?? null, input.avatarUrl ?? null, now], maxRows: 0,
        });
        result = { joinRequest: { id: joinRequestId, spaceId, status: "pending" } };
      } else {
        let spaceChanged = false;
        if (!member) {
          await this.assertPostgresSeatAdmission(transaction, spaceId, String(invite.role), now);
          await insertSpaceMember(transaction, {
            name: "space_invite_accept_member_insert_v1", spaceId, userId: actorUserId,
            role: invite.role, version: 1, email: input.email ?? null,
            displayName: input.name ?? null, avatarUrl: input.avatarUrl ?? null,
            createdAt: now, updatedAt: now,
          });
          await transaction.query({
            name: "space_invite_accept_directory_insert_v1",
            text: `INSERT INTO control.user_space_memberships
              (user_id,space_id,role,membership_version,updated_at) VALUES ($1,$2,$3,1,$4)
              ON CONFLICT (user_id,space_id) DO UPDATE SET role = EXCLUDED.role,
                membership_version = EXCLUDED.membership_version, updated_at = EXCLUDED.updated_at`,
            values: [actorUserId, spaceId, invite.role, now], maxRows: 0,
          });
          spaceChanged = true;
        } else if (input.email !== undefined || input.name !== undefined || input.avatarUrl !== undefined) {
          await transaction.query({
            name: "space_invite_accept_member_profile_v1",
            text: `UPDATE data.space_members SET email = COALESCE($3,email),
                display_name = COALESCE($4,display_name), avatar_url = COALESCE($5,avatar_url),
                version = version + 1, updated_at = $6 WHERE space_id = $1 AND user_id = $2`,
            values: [spaceId, actorUserId, input.email ?? null, input.name ?? null,
              input.avatarUrl ?? null, now], maxRows: 0,
          });
          spaceChanged = true;
        }
        if (spaceChanged) await transaction.query({
          name: "space_invite_accept_space_advance_v1",
          text: "UPDATE data.spaces SET version = version + 1, updated_at = $2 WHERE space_id = $1",
          values: [spaceId, now], maxRows: 0,
        });
        const nextUseCount = useCount + 1;
        const exhausted = maxUses !== null && nextUseCount >= maxUses;
        await transaction.query({
          name: "space_invite_accept_advance_v1",
          text: `UPDATE data.space_invites SET status = $2, use_count = $3,
              accepted_by_user_id = $4, accepted_at = $5, version = version + 1
            WHERE invite_id = $1 AND version = $6`,
          values: [invite.invite_id, exhausted ? "accepted" : "active", nextUseCount,
            actorUserId, now, invite.version], maxRows: 0,
        });
        const spaces = await transaction.query<SpaceRow>({
          name: "space_invite_accept_space_read_v2",
          text: `SELECT space_id,owner_user_id,name,metadata_json,created_at,updated_at
            FROM data.spaces WHERE space_id = $1 LIMIT 1`,
          values: [spaceId], maxRows: 1,
        });
        result = { space: (await this.hydrateSpaces(transaction, spaces, actorUserId))[0]! };
      }
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_invite_accept_head_v1", spaceId, at: now,
      });
      await commitSpaceCommand(transaction, {
        name: "space_invite_accept_outbox_v1", spaceId, commitSequence, aggregateKind: "space-invite",
        aggregateId: invite.invite_id, commandId, commandKind: "accept-space-invite", requestDigest, result,
        at: now,
      });
      return result;
    });
    await this.publishInviteRoute(requestId, placement, tokenHash);
    await this.publishJoinRoutes(requestId, placement, result, actorUserId);
    return result;
  }

  /** Publishes the routes a join changed: the join request it opened, if any, and the joiner's membership. */
  private async publishJoinRoutes(requestId: string, placement: SpacePlacement, result: Record<string, unknown>,
    actorUserId: string): Promise<void> {
    const joinRequest = result.joinRequest && typeof result.joinRequest === "object"
      ? result.joinRequest as Record<string, unknown> : null;
    if (typeof joinRequest?.id === "string") {
      await this.publishJoinRequestRoute(requestId, placement, joinRequest.id);
    }
    await this.publishCurrentMembershipRoute(requestId, placement, actorUserId);
  }

  private async assertPostgresSeatAdmission(
    transaction: DatabaseTransaction, spaceId: string, nextRole: string, now: string,
  ): Promise<void> {
    if (nextRole === "viewer") return;
    rejectBilling(await this.billing.seatAdmission(transaction, { spaceId, now }));
  }

  async joinOpenSpace(input: {
    requestId: string; commandId: string; spaceId: string; actorUserId: string;
    email?: string; name?: string; avatarUrl?: string;
  }): Promise<Record<string, unknown>> {
    const { requestId, commandId, actorUserId, spaceId } = actorCommand(input);
    const requestDigest = await digest(input);
    const now = new Date().toISOString();
    const placement = await this.placement(requestId, "space-join.open", spaceId);
    const result = await this.inSpace(requestId, "space-join.open", placement, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "join-open-space", requestDigest,
      );
      if (replay) return replay;
      const spaces = await transaction.query<SpaceRow>({
        name: "space_join_open_space_lock_v2",
        text: `SELECT space_id,owner_user_id,name,metadata_json,created_at,updated_at
          FROM data.spaces WHERE space_id = $1 FOR UPDATE`,
        values: [spaceId], maxRows: 1,
      });
      const space = spaces[0];
      if (!space || await isSpaceDeletionPending(transaction, spaceId)) {
        throw new SpaceControlError("space_not_found", 404, "Space not found");
      }
      const policy = space.metadata_json?.joinPolicy;
      if (policy !== "open" && policy !== "approval") throw new SpaceControlError(
        "space_not_joinable", 403, "This Space is invite-only",
      );
      const existing = await transaction.query({
        name: "space_join_open_member_v1",
        text: "SELECT user_id FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
        values: [spaceId, actorUserId], maxRows: 1,
      });
      if (existing[0]) {
        return { space: (await this.hydrateSpaces(transaction, spaces, actorUserId))[0]! };
      }
      let result: Record<string, unknown>;
      let aggregateId: string;
      if (policy === "approval") {
        const joinRequestId = `join:${spaceId}:${actorUserId}`.slice(0, 300);
        await transaction.query({
          name: "space_join_open_request_upsert_v1",
          text: `INSERT INTO data.space_join_requests
            (join_request_id,space_id,invite_id,user_id,role,status,email,display_name,
             avatar_url,decided_by_user_id,version,created_at,decided_at)
            VALUES ($1,$2,$3,$4,'member','pending',$5,$6,$7,NULL,1,$8,NULL)
            ON CONFLICT (join_request_id) DO UPDATE SET status = 'pending',
              email = EXCLUDED.email, display_name = EXCLUDED.display_name,
              avatar_url = EXCLUDED.avatar_url, decided_by_user_id = NULL, decided_at = NULL,
              version = data.space_join_requests.version + 1, created_at = EXCLUDED.created_at`,
            values: [joinRequestId, spaceId, `space-policy:${spaceId}`.slice(0, 300), actorUserId,
            input.email ?? null, input.name ?? null, input.avatarUrl ?? null, now], maxRows: 0,
        });
        aggregateId = joinRequestId;
        result = { joinRequest: { id: joinRequestId, spaceId, status: "pending" } };
      } else {
        await this.assertPostgresSeatAdmission(transaction, spaceId, "member", now);
        await insertSpaceMember(transaction, {
          name: "space_join_open_member_insert_v1", spaceId, userId: actorUserId,
          role: "member", version: 1, email: input.email ?? null,
          displayName: input.name ?? null, avatarUrl: input.avatarUrl ?? null,
          createdAt: now, updatedAt: now,
        });
        await transaction.query({
          name: "space_join_open_directory_insert_v1",
          text: `INSERT INTO control.user_space_memberships
            (user_id,space_id,role,membership_version,updated_at)
            VALUES ($1,$2,'member',1,$3)`,
          values: [actorUserId, spaceId, now], maxRows: 0,
        });
        await transaction.query({
          name: "space_join_open_space_advance_v1",
          text: "UPDATE data.spaces SET version = version + 1, updated_at = $2 WHERE space_id = $1",
          values: [spaceId, now], maxRows: 0,
        });
        space.updated_at = now;
        aggregateId = `${spaceId}:${actorUserId}`;
        result = { space: (await this.hydrateSpaces(transaction, [space], actorUserId))[0]! };
      }
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_join_open_head_v1", spaceId, at: now,
      });
      await commitSpaceCommand(transaction, {
        name: "space_join_open_outbox_v1", spaceId, commitSequence, aggregateKind: "space-join", aggregateId,
        commandId, commandKind: "join-open-space", requestDigest, result, at: now,
      });
      return result;
    });
    await this.publishJoinRoutes(requestId, placement, result, actorUserId);
    return result;
  }

  async decideSpaceJoinRequest(input: {
    requestId: string; commandId: string; joinRequestId: string;
    actorUserId: string; approve: boolean;
  }): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const joinRequestId = bounded(input.joinRequestId, "joinRequestId");
    const actorUserId = bounded(input.actorUserId, "actorUserId");
    const route = await this.entityDirectory.resolve(
      { requestId, operation: "space-join-request.locate" },
      "space-join-request", joinRequestId,
    );
    const legacy = route ? null : await this.transaction(
      { requestId, operation: "space-join-request.locate-legacy" },
      (transaction) => transaction.query<QueryResultRow & { space_id: string }>({
        name: "space_join_request_locate_legacy_v1",
        text: "SELECT space_id FROM data.space_join_requests WHERE join_request_id = $1 LIMIT 1",
        values: [joinRequestId], maxRows: 1,
      }),
    );
    const spaceId = route?.spaceId ?? legacy?.[0]?.space_id;
    if (!spaceId) throw new SpaceControlError(
      "join_request_not_found", 404, "No pending join request",
    );
    const requestDigest = await digest(input);
    const now = new Date().toISOString();
    const placement = await this.placement(requestId, "space-join-request.decide", spaceId);
    const result = await this.inSpace(requestId, "space-join-request.decide", placement, async (transaction) => {
      const replay = await idempotentReplay(
        transaction, spaceId, commandId, "decide-space-join-request", requestDigest,
      );
      if (replay) return replay;
      await requireSpaceAdmin(transaction, "space_join_request_decide_admin_v1", spaceId, actorUserId);
      const requests = await transaction.query<QueryResultRow>({
        name: "space_join_request_decide_lock_v1",
        text: `SELECT * FROM data.space_join_requests
          WHERE join_request_id = $1 AND status = 'pending' FOR UPDATE`,
        values: [joinRequestId], maxRows: 1,
      });
      const join = requests[0];
      if (!join) throw new SpaceControlError(
        "join_request_not_found", 404, "No pending join request",
      );
      const subjectUserId = String(join.user_id);
      if (input.approve) {
        const members = await transaction.query({
          name: "space_join_request_member_v1",
          text: "SELECT user_id FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
          values: [spaceId, subjectUserId], maxRows: 1,
        });
        if (!members[0]) {
          await this.assertPostgresSeatAdmission(transaction, spaceId, String(join.role), now);
          await insertSpaceMember(transaction, {
            name: "space_join_request_member_insert_v1", spaceId, userId: subjectUserId,
            role: join.role, version: 1, email: join.email ?? null,
            displayName: join.display_name ?? null, avatarUrl: join.avatar_url ?? null,
            createdAt: now, updatedAt: now,
          });
          await transaction.query({
            name: "space_join_request_directory_insert_v1",
            text: `INSERT INTO control.user_space_memberships
              (user_id,space_id,role,membership_version,updated_at) VALUES ($1,$2,$3,1,$4)`,
            values: [subjectUserId, spaceId, join.role, now], maxRows: 0,
          });
          await transaction.query({
            name: "space_join_request_space_advance_v1",
            text: "UPDATE data.spaces SET version = version + 1, updated_at = $2 WHERE space_id = $1",
            values: [spaceId, now], maxRows: 0,
          });
        }
      }
      const changed = await transaction.query({
        name: "space_join_request_decide_v1",
        text: `UPDATE data.space_join_requests SET status = $2, decided_by_user_id = $3,
          decided_at = $4, version = version + 1
          WHERE join_request_id = $1 AND status = 'pending' RETURNING join_request_id`,
        values: [joinRequestId, input.approve ? "approved" : "denied", actorUserId, now],
        maxRows: 1,
      });
      if (!changed[0]) throw new SpaceControlError("conflict", 409, "join request changed");
      const commitSequence = await requiredControlHead(transaction, {
        name: "space_join_request_decide_head_v1", spaceId, at: now,
      });
      const result = { requestId: joinRequestId, spaceId, userId: subjectUserId,
        status: input.approve ? "approved" : "denied" };
      await commitSpaceCommand(transaction, {
        name: "space_join_request_decide_outbox_v1", spaceId, commitSequence, aggregateKind: "space-join",
        aggregateId: joinRequestId, commandId, commandKind: "decide-space-join-request", requestDigest, result,
        at: now,
      });
      return result;
    });
    if (typeof result.userId !== "string") throw new SpaceControlError(
      "membership_directory_source_incomplete", 503,
      "Membership directory source is incomplete", true,
    );
    await this.publishJoinRequestRoute(requestId, placement, joinRequestId);
    await this.publishCurrentMembershipRoute(requestId, placement, result.userId);
    return result;
  }

  async listSpaceJoinRequests(input: {
    requestId: string; spaceId: string; actorUserId: string; cursor?: string; limit?: number;
  }): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const spaceId = bounded(input.spaceId, "spaceId");
    const actorUserId = bounded(input.actorUserId, "actorUserId");
    const cursor = input.cursor ? bounded(input.cursor, "cursor", 300) : "";
    const limit = pageLimit(input.limit);
    return this.inSpace(requestId, "space-join-request.list", spaceId, async (transaction) => {
      await requireSpaceAdmin(transaction, "space_join_request_list_admin_v1", spaceId, actorUserId);
      const rows = await transaction.query<QueryResultRow>({
        name: "space_join_request_list_v1",
        text: `SELECT join_request_id,user_id,role,email,display_name,avatar_url,created_at
          FROM data.space_join_requests WHERE space_id = $1 AND status = 'pending'
            AND join_request_id > $2 ORDER BY join_request_id LIMIT $3`,
        values: [spaceId, cursor, limit + 1], maxRows: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        cursor: rows.length > limit ? String(page.at(-1)!.join_request_id) : null,
        joinRequests: page.map((row) => ({
          id: row.join_request_id, spaceId, userId: row.user_id, role: row.role,
          ...(row.email ? { email: row.email } : {}),
          ...(row.display_name ? { name: row.display_name } : {}),
          ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
          requestedAt: iso(row.created_at as Date | string),
        })),
      };
    });
  }

  async listChannels(input: {
    requestId: string;
    spaceId: string;
    principal: SpaceControlPrincipal;
    channelId?: string;
    /**
     * One Channel and its direct children: rows whose id is this Channel or
     * whose parent is it. A single-Channel read (its Summary, archival and
     * opened threads) needs exactly this, not the whole Space catalog.
     */
    familyOfChannelId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    catalogRevision: number;
    channels: Record<string, unknown>[];
    openChannelHumanMemberIdsBySpace: Record<string, string[]>;
    cursor: string | null;
  }> {
    const { requestId, spaceId, principalId } = principalScope(input);
    const cursor = input.cursor ? bounded(input.cursor, "cursor", 512) : "";
    const limit = pageLimit(input.limit);
    const channelId = input.channelId ? bounded(input.channelId, "channelId") : null;
    const familyOfChannelId = input.familyOfChannelId
      ? bounded(input.familyOfChannelId, "familyOfChannelId") : null;
    return this.inSpace(requestId, "channel.list", spaceId, async (transaction) => {
      const role = await requireSpacePrincipal(transaction, "channel_list", spaceId, input.principal.kind,
        principalId);
      const rows = await transaction.query<ChannelRow>({
        name: "channel_list_v9",
        text: `SELECT c.channel_id, c.space_id, c.name, c.mode,
            c.metadata_json, c.version, c.created_at, c.updated_at,
            $3::text AS creator_role, s.owner_user_id AS created_by_fallback,
            EXISTS (SELECT 1 FROM data.channel_access a
              WHERE a.space_id = c.space_id AND a.channel_id = c.channel_id
                AND a.subject_kind = $7 AND a.subject_id = $2) AS explicit_access,
            COALESCE((SELECT counter.content_revision FROM data.channel_content_counters counter
              WHERE counter.space_id=c.space_id AND counter.channel_id=c.channel_id),0) AS content_revision,
            head.timeline_sequence AS history_head_sequence,
            head.sent_at AS last_message_at,
            CASE WHEN c.mode = 'closed' THEN ARRAY(
              SELECT m.user_id FROM data.space_members m
              LEFT JOIN data.channel_access a ON a.space_id = m.space_id
                AND a.channel_id = c.channel_id AND a.subject_kind = 'user'
                AND a.subject_id = m.user_id
              WHERE m.space_id = c.space_id AND (a.subject_id IS NOT NULL OR
                m.role IN ('owner', 'admin'))
              ORDER BY m.user_id LIMIT 10000
            ) ELSE ARRAY[]::text[] END AS visible_human_ids
          FROM data.channels c JOIN data.spaces s ON s.space_id = c.space_id
          LEFT JOIN LATERAL (
            SELECT message.timeline_sequence, message.sent_at FROM data.messages message
            WHERE message.space_id = c.space_id AND message.channel_id = c.channel_id
              AND message.deleted_at IS NULL
            ORDER BY message.timeline_sequence DESC LIMIT 1
          ) head ON TRUE
          WHERE c.space_id = $1 AND c.channel_id > $4
            AND ($5::text IS NULL OR c.channel_id = $5)
            AND ($8::text IS NULL OR c.channel_id = $8 OR c.metadata_json->>'threadRootChannelId' = $8)
            AND ${channelCapabilityPredicate({ capability: "catalog_read", channelAlias: "c",
              principalKindSql: "$7", principalIdSql: "$2" })}
          ORDER BY c.channel_id LIMIT $6`,
        values: [
          spaceId, principalId, role, cursor, channelId, limit + 1, input.principal.kind,
          familyOfChannelId,
        ],
        maxRows: limit + 1,
      });
      const page = rows.slice(0, limit);
      const presence = await loadChannelAgentPresence(
        transaction, spaceId, page.map((row) => row.channel_id),
      );
      const serialized: Record<string, unknown>[] = [];
      for (const row of page) {
        serialized.push(serializeChannel(
          row, row.visible_human_ids ?? [],
          presence.get(row.channel_id),
        ));
      }
      const openMemberRows = page.some((row) => row.mode === "open")
        ? await transaction.query<QueryResultRow & { user_id: string }>({
            name: "open_channel_space_members_v1",
            text: `SELECT user_id FROM data.space_members
              WHERE space_id = $1 ORDER BY user_id LIMIT 10000`,
            values: [spaceId], maxRows: 10_000,
          }) : [];
      const heads = await transaction.query<QueryResultRow & { commit_sequence: string | number }>({
        name: "space_control_head_read_v1",
        text: "SELECT commit_sequence FROM data.space_control_heads WHERE space_id = $1 LIMIT 1",
        values: [spaceId], maxRows: 1,
      });
      if (!heads[0]) throw new SpaceControlError(
        "space_control_head_missing", 500, "Space control head is unavailable",
      );
      return {
        catalogRevision: Number(heads[0].commit_sequence),
        channels: serialized,
        openChannelHumanMemberIdsBySpace: openMemberRows.length > 0
          ? { [spaceId]: openMemberRows.map((row) => `user:${row.user_id}`) } : {},
        cursor: rows.length > limit ? page.at(-1)?.channel_id ?? null : null,
      };
    });
  }

  async getChannelCatalogRevision(input: {
    requestId: string;
    spaceId: string;
    principal: SpaceControlPrincipal;
  }): Promise<{ revision: number }> {
    const { requestId, spaceId, principalId } = userScope(
      input, "only users may incrementally sync Channel catalogs",
    );
    return this.inSpace(requestId, "channel.catalog-revision", spaceId, async (transaction) => {
      const rows = await transaction.query<QueryResultRow & { commit_sequence: string | number }>({
        name: "channel_catalog_revision_v1",
        text: `SELECT h.commit_sequence FROM data.space_control_heads h
          JOIN data.space_members m ON m.space_id = h.space_id
          WHERE h.space_id = $1 AND m.user_id = $2 LIMIT 1`,
        values: [spaceId, principalId], maxRows: 1,
      });
      if (!rows[0]) throw new SpaceControlError("space_not_found", 404, "Space not found");
      return { revision: Number(rows[0].commit_sequence) };
    });
  }

  /**
   * Read the post-commit catalog watermarks and exact Space-member audiences.
   * This is acceleration metadata only: recipients must still re-read the
   * catalog, whose row-level ACL remains authoritative.
   */
  async channelCatalogChangeAudiences(input: {
    requestId: string;
    spaceIds: readonly string[];
  }): Promise<ChannelCatalogChangeAudience[]> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const spaceIds = [...new Set(input.spaceIds.map((value) => bounded(value, "spaceId")))];
    if (spaceIds.length < 1 || spaceIds.length > 2) {
      throw new SpaceControlError(
        "invalid_request", 400, "Catalog change audience requires one or two Spaces",
      );
    }
    const audiences: ChannelCatalogChangeAudience[] = [];
    for (const spaceId of spaceIds) {
      const rows = await this.inSpace(requestId, "channel.catalog-change-audience", spaceId, async (transaction) => {
        const rows: Array<QueryResultRow & { commit_sequence: string | number; user_id: string }> = [];
        let after: string | null = null;
        // Keep the existing 100k fanout bound without violating the database
        // client's 10k per-query limit. One serializable snapshot binds every
        // page to the same membership facts and control revision.
        while (rows.length <= 100_000) {
          const page: ReadonlyArray<QueryResultRow & { commit_sequence: string | number; user_id: string }> = await transaction.query({
            name: "channel_catalog_change_audience_v2",
            text: `SELECT h.commit_sequence, m.user_id FROM data.space_control_heads h
              JOIN data.space_members m ON m.space_id=h.space_id
              WHERE h.space_id=$1 AND ($2::text IS NULL OR m.user_id>$2)
              ORDER BY m.user_id LIMIT 10000`,
            values: [spaceId, after], maxRows: 10_000,
          });
          rows.push(...page);
          if (page.length < 10_000) break;
          after = page[page.length - 1]!.user_id;
        }
        return rows;
      });
      if (rows.length === 0) {
        throw new SpaceControlError("space_not_found", 404, "Space not found");
      }
      if (rows.length > 100_000) {
        throw new SpaceControlError(
          "catalog_change_audience_too_large", 503,
          "Catalog change audience exceeds the realtime fanout bound", true,
        );
      }
      const revision = Number(rows[0]!.commit_sequence);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new SpaceControlError(
          "space_control_head_invalid", 500, "Space control head is invalid",
        );
      }
      audiences.push({
        spaceId,
        revision,
        recipientUserIds: rows.map((row) => row.user_id),
      });
    }
    return audiences;
  }

  async createTransferProposal(input: { requestId: string; proposalId: string; channelId: string;
    targetSpaceId: string; principal: SpaceControlPrincipal;
    ownerUserId?: string }): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const proposalId = bounded(input.proposalId, "proposalId");
    const channelId = bounded(input.channelId, "channelId");
    const targetSpaceId = bounded(input.targetSpaceId, "targetSpaceId");
    const sourceSpaceId = await this.resolveChannelSpaceId({ requestId, channelId });
    // Establish source access before looking up the supplied opaque target coordinate.
    await this.getChannel({ requestId, spaceId: sourceSpaceId, channelId, principal: input.principal });
    if (sourceSpaceId === targetSpaceId) throw new SpaceControlError("same_space_transfer", 400,
      "Use the ordinary parent change for a move within one Space");
    const source = await this.placement(requestId, "transfer.source", sourceSpaceId);
    const target = await this.placement(requestId, "transfer.target", targetSpaceId);
    if (source.shardId !== target.shardId) throw new SpaceControlError(
      "cross_shard_move_requires_copy", 409, "cross-shard Channel moves require copy-and-fence migration");
    return this.transaction({ requestId, operation: "transfer.propose", isolation: "serializable",
      placement: { spaceId: sourceSpaceId, shardId: source.shardId, placementEpoch: source.placementEpoch },
    }, async (tx) => {
      const targetFence = await tx.query({ name: "transfer_draft_target_fence_v1",
        text: `SELECT space_id FROM control.space_placement WHERE space_id=$1 AND shard_id=$2
          AND placement_epoch=$3 AND state='active' AND target_shard_id IS NULL FOR SHARE`,
        values: [targetSpaceId, target.shardId, target.placementEpoch], maxRows: 1 });
      if (!targetFence[0]) throw new SpaceControlError("transfer_target_moving", 409,
        "Target Space placement changed; retry after its migration finishes");
      const snapshot = await transferSnapshot(tx, sourceSpaceId, targetSpaceId, channelId);
      if (input.principal.kind === "user") requireTransferAdmin(snapshot, sourceSpaceId, input.principal.id);
      else {
        const agents = await tx.query({ name: "transfer_draft_agent_access_v4",
          text: `SELECT c.channel_id FROM data.channels c
            WHERE c.space_id = $2 AND c.channel_id = $3
              AND ${channelCapabilityPredicate({ capability: "space_transfer_propose", channelAlias: "c",
                principalKindSql: "'agent'", principalIdSql: "$1" })} LIMIT 1`,
          values: [input.principal.id, sourceSpaceId, channelId], maxRows: 1 });
        if (!agents[0]) throw new SpaceControlError("channel_not_found", 404, "Channel not found");
      }
      const existing = await tx.query<TransferRow>({ name: "transfer_replay_v1",
        text: `SELECT * FROM data.channel_transfer_proposals WHERE space_id = $1 AND proposal_id = $2`,
        values: [sourceSpaceId, proposalId], maxRows: 1 });
      if (existing[0] && (existing[0].channel_id !== channelId || existing[0].target_space_id !== targetSpaceId ||
          existing[0].target_parent_id !== null || existing[0].created_by_id !== input.principal.id ||
          existing[0].created_by_kind !== input.principal.kind)) throw new SpaceControlError(
        "transfer_id_conflict", 409, "Proposal id belongs to a different request");
      const row: TransferRow = existing[0] ?? {
        space_id: sourceSpaceId, proposal_id: proposalId, target_space_id: targetSpaceId,
        channel_id: channelId, target_parent_id: null, created_by_kind: input.principal.kind,
        created_by_id: input.principal.id, snapshot_json: snapshot, outbound_user_id: null,
        outbound_at: null, inbound_user_id: null, inbound_at: null, status: "pending",
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      };
      if (!existing[0]) {
        const pending = await tx.query({ name: "transfer_capacity_v1", text: `SELECT proposal_id
          FROM data.channel_transfer_proposals WHERE (space_id = ANY($1::text[]) OR target_space_id = ANY($1::text[]))
            AND status='pending' AND expires_at>clock_timestamp() LIMIT 100`,
          values: [[sourceSpaceId, targetSpaceId]], maxRows: 100 });
        if (pending.length >= 100) throw new SpaceControlError("transfer_capacity", 409,
          "Too many pending transfers for these Spaces; resolve existing proposals first");
      }
      if (!existing[0]) await tx.query({ name: "transfer_create_v1", text: `INSERT INTO data.channel_transfer_proposals
        (space_id, proposal_id, target_space_id, channel_id, target_parent_id, created_by_kind, created_by_id,
         snapshot_json, status, created_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending',$9,$10)`,
        values: [sourceSpaceId, proposalId, targetSpaceId, channelId, null, input.principal.kind,
          input.principal.id, JSON.stringify(snapshot), row.created_at, row.expires_at], maxRows: 0 });
      // Agent drafts do not disclose target membership, other Spaces' metadata, or acknowledgement capabilities.
      return { proposal: input.principal.kind === "agent"
        ? { id: proposalId, sourceSpaceId, targetSpaceId, channelId, status: row.status,
            instruction: "Ask human admins to confirm outbound and inbound in Web. Agents cannot acknowledge." }
        : transferView(row, input.principal.id) };
    });
  }

  async listTransferProposals(input: { requestId: string; spaceId: string; principal: SpaceControlPrincipal;
    channelId?: string }): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const spaceId = bounded(input.spaceId, "spaceId");
    if (input.principal.kind !== "user") throw new SpaceControlError(
      "human_required", 403, "Only human admins may review transfer proposals");
    const placement = await this.placement(requestId, "transfer.list", spaceId);
    return this.transaction({ requestId, operation: "transfer.list",
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, async (tx) => {
      const admins = await tx.query({ name: "transfer_list_admin_v1", text: `SELECT user_id
        FROM data.space_members WHERE space_id = $1 AND user_id = $2 AND role IN ('owner','admin') LIMIT 1`,
        values: [spaceId, input.principal.id], maxRows: 1 });
      if (!admins[0]) throw new SpaceControlError("transfer_admin_required", 403, "Space admin required");
      const rows = await tx.query<TransferRow>({ name: "transfer_list_v1", text: `SELECT *
        FROM data.channel_transfer_proposals WHERE (space_id = $1 OR target_space_id = $1)
          AND ($2::text IS NULL OR channel_id = $2)
          AND ((status='pending' AND expires_at>clock_timestamp()) OR
            (status='completed' AND completed_at>clock_timestamp()-interval '1 day'))
        ORDER BY (status='pending') DESC, created_at DESC, proposal_id DESC LIMIT 100`,
        values: [spaceId, input.channelId ?? null], maxRows: 100 });
      return { proposals: rows.map((row) => transferView(row, input.principal.id)) };
    });
  }

  async acknowledgeTransferProposal(input: { requestId: string; sourceSpaceId: string; proposalId: string;
    role: TransferRole; principal: SpaceControlPrincipal }): Promise<Record<string, unknown>> {
    if (input.principal.kind !== "user") throw new SpaceControlError(
      "human_required", 403, "Only humans may acknowledge a transfer; use Web outbound/inbound confirmation");
    if (input.role !== "outbound" && input.role !== "inbound") throw new SpaceControlError(
      "invalid_transfer_role", 400, "Confirm exactly one role: outbound or inbound");
    const requestId = bounded(input.requestId, "requestId", 200);
    const sourceSpaceId = bounded(input.sourceSpaceId, "sourceSpaceId");
    const proposalId = bounded(input.proposalId, "proposalId");
    const placement = await this.placement(requestId, "transfer.acknowledge", sourceSpaceId);
    const row = await this.transaction({ requestId, operation: "transfer.acknowledge", isolation: "serializable",
      placement: { spaceId: sourceSpaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, async (tx) => {
      const row = await lockTransfer(tx, sourceSpaceId, proposalId);
      const roleSpace = input.role === "outbound" ? row.space_id : row.target_space_id;
      const admins = await tx.query({ name: "transfer_ack_admin_v1", text: `SELECT user_id
        FROM data.space_members WHERE space_id = $1 AND user_id = $2 AND role IN ('owner','admin') LIMIT 1`,
        values: [roleSpace, input.principal.id], maxRows: 1 });
      if (!admins[0]) throw new SpaceControlError("transfer_admin_required", 403, "This role requires its Space admin");
      if (row.status === "completed") return row;
      await validateTransfer(tx, row);
      const userField = input.role === "outbound" ? "outbound_user_id" : "inbound_user_id";
      const timeField = input.role === "outbound" ? "outbound_at" : "inbound_at";
      if (!row[userField]) {
        row[userField] = input.principal.id;
        row[timeField] = new Date().toISOString();
        await tx.query({ name: `transfer_ack_${input.role}_v1`, text: `UPDATE data.channel_transfer_proposals
          SET ${userField} = $3, ${timeField} = $4 WHERE space_id = $1 AND proposal_id = $2`,
          values: [sourceSpaceId, proposalId, input.principal.id, row[timeField]], maxRows: 0 });
      }
      return row;
    });
    let stopTargets: unknown[] = [];
    if (row.status !== "completed" && row.outbound_user_id && row.inbound_user_id) {
      const moved = await this.mutateChannel({ requestId, commandId: `transfer:${proposalId}`, kind: "channel_configure",
        channelId: row.channel_id, spaceId: row.target_space_id,
        actorUserId: input.principal.id, at: new Date().toISOString(),
        moveTree: row.snapshot_json.tree.map((channel) => ({ channelId: channel.channel_id,
          expectedVersion: Number(channel.version) })),
      }, { sourceSpaceId, proposalId });
      if (Array.isArray(moved.archiveStopTargets)) stopTargets = moved.archiveStopTargets;
      row.status = "completed";
    }
    return { proposal: transferView(row, input.principal.id),
      ...(stopTargets.length > 0 ? { stopTargets } : {}) };
  }

  async mutateChannel(
    input: PostgresChannelMutation,
    transfer?: { sourceSpaceId: string; proposalId: string },
    resolvedSourceSpaceId?: string,
  ): Promise<Record<string, unknown>> {
    const requestId = bounded(input.requestId, "requestId", 200);
    const commandId = bounded(input.commandId, "commandId");
    const channelId = bounded(input.channelId, "channelId");
    const actorUserId = bounded(input.actorUserId, "actorUserId");
    requireExpectedVersion(input.expectedVersion, 1);
    const at = iso(input.at);
    const sourceSpaceId = transfer?.sourceSpaceId ??
      (resolvedSourceSpaceId ? bounded(resolvedSourceSpaceId, "sourceSpaceId")
        : await this.resolveChannelSpaceId({ requestId, channelId }));
    const placement = await this.placement(requestId, `channel.${input.kind}`, sourceSpaceId);
    const targetPlacement = input.kind === "channel_configure" && input.spaceId &&
        input.spaceId !== sourceSpaceId
      ? await this.placement(requestId, "channel.cross-space-move", input.spaceId)
      : null;
    if (targetPlacement && targetPlacement.shardId !== placement.shardId) {
      throw new SpaceControlError(
        "cross_shard_move_requires_copy", 409,
        "cross-shard Channel moves require copy-and-fence migration",
      );
    }
    const requestDigest = await digest(input);
    const result = await this.transaction({
      isolation: "serializable",
      requestId, operation: `channel.${input.kind}`,
      placement: {
        spaceId: sourceSpaceId,
        shardId: placement.shardId,
        placementEpoch: placement.placementEpoch,
      },
    }, async (transaction) => {
      if (transfer) {
        const proposal = await lockTransfer(transaction, transfer.sourceSpaceId, transfer.proposalId);
        if (proposal.status === "completed") {
          return { entityId: proposal.channel_id,
            affectedChannelIds: proposal.snapshot_json.tree.map((row) => row.channel_id) };
        }
      }
      const replay = await idempotentReplay(
        transaction, sourceSpaceId, commandId, input.kind, requestDigest,
      );
      if (replay) return replay;
      const roots = await transaction.query<ChannelRow>({
        name: "channel_mutation_root_lock_v2",
        text: `SELECT channel_id, space_id, name, mode,
            metadata_json, version, search_rank_sequence, created_at, updated_at
          FROM data.channels WHERE channel_id = $1 FOR UPDATE`,
        values: [channelId], maxRows: 1,
      });
      const root = roots[0];
      if (!root) throw new SpaceControlError("not_found", 404, "channel not found");
      const expectedVersion = input.expectedVersion ?? Number(root.version);
      if (Number(root.version) !== expectedVersion) {
        throw new SpaceControlError("conflict", 409, "channel version conflict");
      }
      const admins = await transaction.query({
        name: "channel_mutation_admin_v1",
        text: `SELECT user_id FROM data.space_members
          WHERE space_id = $1 AND user_id = $2 AND role IN ('owner', 'admin') LIMIT 1`,
        values: [root.space_id, actorUserId], maxRows: 1,
      });
      if (!admins[0] && !transfer) throw new SpaceControlError("forbidden", 403, "Space admin required");

      let entityVersion = Number(root.version);
      let affected: ChannelRow[] = [];
      let movedToSpaceId: string | null = null;
      let explicitProjectionMutations: Record<string, unknown>[] | null = null;
      let archiveStopTargets: Record<string, unknown>[] = [];
      let instancesKilled = 0;
      if (input.kind === "channel_configure") {
        if (input.spaceId !== undefined && input.spaceId !== root.space_id) {
          if (!transfer) throw new SpaceControlError("transfer_proposal_required", 409,
            "Cross-Space moves require a proposal and separate human outbound and inbound confirmations");
          const targetFence = await transaction.query({ name: "transfer_target_placement_fence_v1",
            text: `SELECT space_id FROM control.space_placement WHERE space_id=$1 AND shard_id=$2
              AND placement_epoch=$3 AND state='active' AND target_shard_id IS NULL FOR SHARE`,
            values: [input.spaceId, targetPlacement?.shardId, targetPlacement?.placementEpoch], maxRows: 1 });
          if (!targetFence[0]) throw new SpaceControlError("transfer_target_moving", 409,
            "Target Space placement changed; retry after its migration finishes");
          const proposal = await lockTransfer(transaction, transfer.sourceSpaceId, transfer.proposalId);
          if (proposal.status !== "pending" || proposal.channel_id !== channelId ||
              proposal.space_id !== root.space_id || proposal.target_space_id !== input.spaceId ||
              !proposal.outbound_user_id || !proposal.inbound_user_id) {
            throw new SpaceControlError("transfer_confirmation_required", 403, "Both human confirmations are required");
          }
          const snapshot = await validateTransfer(transaction, proposal);
          if (!snapshot.members.some((member) => member.user_id === actorUserId &&
              ["owner", "admin"].includes(member.role))) throw new SpaceControlError(
            "transfer_admin_required", 403, "Current Space admin required");
          requireTransferAdmin(snapshot, proposal.space_id, proposal.outbound_user_id);
          requireTransferAdmin(snapshot, proposal.target_space_id, proposal.inbound_user_id);
          const targetSpaceId = bounded(input.spaceId, "spaceId");
          if (input.moveTree && (input.moveTree.length === 0 || input.moveTree.length > 10_000)) {
            throw new SpaceControlError(
              "invalid_command", 400, "cross-Space Channel move requires a bounded exact tree snapshot",
            );
          }
          const targetAdmins = await transaction.query({
            name: "channel_move_target_admin_v1",
            text: `SELECT user_id FROM data.space_members
              WHERE space_id = $1 AND user_id = $2 AND role IN ('owner', 'admin') LIMIT 1`,
            values: [targetSpaceId, proposal.inbound_user_id], maxRows: 1,
          });
          if (!targetAdmins[0]) throw new SpaceControlError(
            "forbidden", 403, "target Space admin required",
          );
          // A conversation moves alone: whatever once sat under it stays where it is.
          const moveRows = [root];
          if (moveRows.some((row) => row.space_id !== root.space_id)) {
            throw new SpaceControlError("conflict", 409, "Channel tree changed while move was prepared");
          }
          const actual = moveRows.map((row) => ({
            channelId: row.channel_id, expectedVersion: Number(row.version),
          })).sort((left, right) => left.channelId.localeCompare(right.channelId));
          if (input.moveTree) {
            const expected = input.moveTree.map((row) => ({
              channelId: bounded(row.channelId, "moveTree.channelId"),
              expectedVersion: row.expectedVersion,
            })).sort((left, right) => left.channelId.localeCompare(right.channelId));
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              throw new SpaceControlError("conflict", 409, "Channel tree changed while move was prepared");
            }
          }
          const ids = moveRows.map((row) => row.channel_id);
          // Live work and Channel-bound authority end with the move, as live
          // work does on archive; the blocker query below still fails closed
          // on live work the move could not account for.
          const stopped = await terminalizeArchivedChannelTree(transaction, ids, at);
          archiveStopTargets = stopped.archiveStopTargets;
          instancesKilled = stopped.instancesKilled;
          await releaseChannelTreeForMove(transaction, ids, at);
          const blockers = await transaction.query<QueryResultRow & { blocker_kind: string }>({
            name: "channel_move_blockers_v3",
            text: `SELECT 'live run' AS blocker_kind FROM data.runs
                WHERE channel_id = ANY($1::text[]) AND status IN (${ACTIVE_RUN_STATUS_SQL})
              UNION ALL SELECT 'live instance' AS blocker_kind FROM data.instances i
                WHERE i.channel_id = ANY($1::text[]) AND i.status <> 'offline'
                  AND NOT EXISTS (SELECT 1 FROM data.runs r
                    WHERE r.run_id = i.run_id AND r.channel_id = i.channel_id
                      AND r.status IN (${TERMINAL_RUN_STATUS_SQL}))
              LIMIT 1`,
            values: [ids], maxRows: 1,
          });
          if (blockers[0]) throw new SpaceControlError(
            "conflict", 409, `resolve ${blockers[0].blocker_kind} before moving`,
          );
          const nextName = input.name === undefined ? root.name : bounded(input.name, "name");
          const nextMode = input.mode ?? root.mode;
          await transaction.query({
            name: "channel_move_prune_acl_v2",
            text: `DELETE FROM data.channel_access a WHERE a.channel_id = ANY($1::text[]) AND (
                (a.subject_kind = 'user' AND NOT EXISTS (SELECT 1 FROM data.space_members m
                  WHERE m.space_id = $2 AND m.user_id = a.subject_id)) OR
                (a.subject_kind = 'agent' AND NOT ${agentInSpacePredicate("$2", "a.subject_id")}))`,
            values: [ids, targetSpaceId], maxRows: 0,
          });
          const rootMetadata = { ...root.metadata_json };
          if (input.topic !== undefined) {
            if (input.topic === null) delete rootMetadata.topic;
            else rootMetadata.topic = input.topic.trim();
          }
          if (input.summary !== undefined) {
            if (input.summary === null) delete rootMetadata.summary;
            else rootMetadata.summary = input.summary.trim();
            await recordSummarySource(transaction, rootMetadata, root.space_id, channelId, input, at);
          }
          if (input.managementMetadata !== undefined) {
            rootMetadata.xmatrixManagement = {
              ...(typeof rootMetadata.xmatrixManagement === "object" &&
                rootMetadata.xmatrixManagement !== null && !Array.isArray(rootMetadata.xmatrixManagement)
                ? rootMetadata.xmatrixManagement as Record<string, unknown> : {}),
              ...input.managementMetadata,
            };
          }
          explicitProjectionMutations = [];
          for (const row of moveRows) {
            const isRoot = row.channel_id === channelId;
            const version = Number(row.version) + 1;
            const nextRow: ChannelRow = {
              ...row,
              space_id: targetSpaceId,
              name: isRoot ? nextName : row.name,
              mode: isRoot ? nextMode : row.mode,
              metadata_json: isRoot ? rootMetadata : row.metadata_json,
              version,
              updated_at: at,
            };
            const changed = await transaction.query({
              name: "channel_move_row_v2",
              text: `UPDATE data.channels SET space_id = $2,
                  name = $3, name_key = $4, mode = $5,
                  metadata_json = $6::jsonb, version = $7, updated_at = $8,
                  activity_at=GREATEST(COALESCE(activity_at,updated_at),$8::timestamptz)
                WHERE channel_id = $1 AND version = $9 RETURNING channel_id`,
              values: [row.channel_id, targetSpaceId, nextRow.name,
                channelNameStorageKey(nextRow.name, row.channel_id), nextRow.mode,
                JSON.stringify(nextRow.metadata_json), version, at, row.version], maxRows: 1,
            });
            if (!changed[0]) throw new SpaceControlError("conflict", 409, "Channel tree changed");
            await transaction.query({
              name: "channel_move_acl_scope_v1",
              text: "UPDATE data.channel_access SET space_id = $2, updated_at = $3 WHERE channel_id = $1",
              values: [row.channel_id, targetSpaceId, at], maxRows: 0,
            });
            await transaction.query({
              name: "channel_move_directory_v1",
              text: `UPDATE control.channel_space_directory SET space_id = $2, updated_at = $3
                WHERE channel_id = $1`,
              values: [row.channel_id, targetSpaceId, at], maxRows: 0,
            });
            const oldScope = channelScope(row);
            const newScope = channelScope(nextRow);
            if (oldScope !== newScope) {
              explicitProjectionMutations.push(projectionMutation(row, version, "tombstone"));
            }
            explicitProjectionMutations.push(projectionMutation(nextRow, version, "upsert"));
            affected.push(nextRow);
            if (isRoot) entityVersion = version;
          }
          await moveChannelSpaceFacts(transaction, root.space_id, targetSpaceId, ids);
          await transaction.query({ name: "transfer_complete_v1", text: `UPDATE data.channel_transfer_proposals
            SET status = 'completed', completed_at = $3 WHERE space_id = $1 AND proposal_id = $2`,
            values: [proposal.space_id, proposal.proposal_id, at], maxRows: 0 });
          movedToSpaceId = targetSpaceId;
        } else if (input.moveTree) {
          throw new SpaceControlError(
            "invalid_command", 400, "moveTree is only valid for a cross-Space move",
          );
        }
        if (movedToSpaceId) {
          // The exact tree was already updated above.
        } else {
        const nextName = input.name === undefined ? root.name : bounded(input.name, "name");
        const nextMode = input.mode ?? root.mode;
        const nextMetadata = { ...root.metadata_json };
        if (input.name !== undefined) {
          if (input.automaticName && nextMetadata.autoName !== true) {
            throw new SpaceControlError("channel_named_by_person", 409, "Someone named this conversation");
          }
          if (!input.automaticName) delete nextMetadata.autoName;
        }
        if (input.topic !== undefined) {
          if (input.topic === null) delete nextMetadata.topic;
          else nextMetadata.topic = input.topic.trim();
        }
        if (input.summary !== undefined) {
          if (input.summary === null) delete nextMetadata.summary;
          else nextMetadata.summary = input.summary.trim();
          await recordSummarySource(transaction, nextMetadata, root.space_id, channelId, input, at);
        }
        if (input.managementMetadata !== undefined) {
          nextMetadata.xmatrixManagement = {
            ...(typeof nextMetadata.xmatrixManagement === "object" &&
              nextMetadata.xmatrixManagement !== null &&
              !Array.isArray(nextMetadata.xmatrixManagement)
              ? nextMetadata.xmatrixManagement as Record<string, unknown> : {}),
            ...input.managementMetadata,
          };
        }
        entityVersion += 1;
        const updated = await transaction.query<ChannelRow>({
          name: "channel_configure_v3",
          text: `UPDATE data.channels SET name = $2, name_key = $3, mode = $4, metadata_json = $5::jsonb,
              version = $6, updated_at = $7,
              activity_at=GREATEST(COALESCE(activity_at,updated_at),$7::timestamptz)
            WHERE channel_id = $1 AND version = $8
            RETURNING channel_id, space_id, name, mode,
              metadata_json, version, search_rank_sequence, created_at, updated_at`,
          values: [channelId, nextName, channelNameStorageKey(nextName, channelId), nextMode,
            JSON.stringify(nextMetadata), entityVersion, at, expectedVersion],
          maxRows: 1,
        });
        if (!updated[0]) throw new SpaceControlError("conflict", 409, "channel changed");
        affected = [updated[0]];
        }
      }

      const commitSequence = await requiredControlHead(transaction, {
        name: "channel_mutation_head_advance_v1", spaceId: root.space_id, at,
      });
      if (movedToSpaceId) {
        const targetSequence = await advanceSpaceControlHead(transaction, {
          name: "channel_move_target_head_advance_v1", spaceId: movedToSpaceId, at,
        });
        if (targetSequence === undefined) throw new SpaceControlError(
          "space_control_head_missing", 500, "target Space control head is unavailable",
        );
      }
      const projectionMutations = explicitProjectionMutations ??
        affected.map((row) => projectionMutation(row, Number(row.version), "upsert"));
      const members = await transaction.query<QueryResultRow & { user_id: string }>({
        name: "channel_mutation_recipients_v1",
        text: `SELECT DISTINCT user_id FROM data.space_members
          WHERE space_id = ANY($1::text[]) ORDER BY user_id LIMIT 10000`,
        values: [[root.space_id, ...(movedToSpaceId ? [movedToSpaceId] : [])]], maxRows: 10_000,
      });
      const result: Record<string, unknown> = {
        entityId: channelId,
        entityVersion,
        affectedChannelIds: affected.map((row) => row.channel_id),
        ...(movedToSpaceId ? { archiveStopTargets, instancesKilled } : {}),
        projectionMutations,
        recipientChanges: members.map((member) => ({
          userId: member.user_id,
          visibilityScopeId: `channel:${channelId}`,
          change: "entitlement_changed",
        })),
      };
      await commitSpaceCommand(transaction, {
        name: "channel_mutation_outbox_v1", spaceId: root.space_id, commitSequence, aggregateKind: "channel",
        aggregateId: channelId, commandId, commandKind: input.kind, requestDigest, result, at,
      });
      return result;
    });
    const deletedChannelIds = Array.isArray(result.deletedChannelIds)
      ? result.deletedChannelIds.filter((value): value is string => typeof value === "string") : [];
    if (deletedChannelIds.length > 0) {
      const versions = new Map<string, number>();
      if (Array.isArray(result.projectionMutations)) {
        for (const value of result.projectionMutations) {
          if (value && typeof value === "object") {
            const mutation = value as Record<string, unknown>;
            if (typeof mutation.entityId === "string" &&
                Number.isSafeInteger(Number(mutation.entityVersion))) {
              versions.set(mutation.entityId, Number(mutation.entityVersion));
            }
          }
        }
      }
      await this.channelDirectory.publishMany({
        requestId,
        operation: "channel.directory-publish",
      }, deletedChannelIds.map((deletedId) => ({
        channelId: deletedId,
        spaceId: sourceSpaceId,
        shardId: placement.shardId,
        placementEpoch: placement.placementEpoch,
        entityVersion: versions.get(deletedId) ?? Number(result.entityVersion),
        state: "deleted" as const,
        updatedAt: at,
      })));
    } else {
      const affectedChannelIds = Array.isArray(result.affectedChannelIds)
        ? result.affectedChannelIds.filter((value): value is string => typeof value === "string") : [];
      await this.publishCurrentChannelRoutes(requestId, placement, affectedChannelIds);
    }
    return result;
  }

  private async visibleHumanIds(
    transaction: DatabaseTransaction,
    channel: ChannelRow,
  ): Promise<string[]> {
    const rows = await transaction.query<QueryResultRow & { user_id: string }>({
      name: "closed_channel_visible_members_v1",
      text: `SELECT m.user_id FROM data.space_members m
        LEFT JOIN data.channel_access a ON a.space_id = m.space_id
          AND a.channel_id = $2 AND a.subject_kind = 'user' AND a.subject_id = m.user_id
        WHERE m.space_id = $1 AND (a.subject_id IS NOT NULL OR m.role IN ('owner', 'admin'))
        ORDER BY m.user_id LIMIT 10000`,
      values: [channel.space_id, channel.channel_id],
      maxRows: 10_000,
    });
    return rows.map((row) => row.user_id);
  }
}

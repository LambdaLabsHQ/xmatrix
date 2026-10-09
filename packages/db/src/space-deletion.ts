import type { QueryResultRow } from "pg";
import { parseRestrictedChannelContentScope } from "@xmatrix/protocol";

import type { DatabaseTransaction } from "./contracts.js";
import { insertSpaceMember } from "./space-members.js";
import { SpaceControlError } from "./space-control.js";

/** How long an owner can restore a Space after asking to delete it. */
export const SPACE_DELETION_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const SPACE_DELETION_MEMBER_MAX = 9_999;
export const SPACE_DELETION_AUTOMATION_MAX = 10_000;
const PURGE_BATCH_ROWS = 500;
const PURGE_STEP_ROW_BUDGET = 2_000;
const PURGE_OBJECT_BATCH = 100;

export type SpaceDeletionState = "scheduled" | "purging" | "completed";

export interface SpaceDeletionRow extends QueryResultRow {
  space_id: string;
  space_name: string;
  owner_user_id: string;
  requested_at: Date | string;
  purge_after: Date | string;
  state: SpaceDeletionState;
  members_json: SpaceDeletionMember[] | null;
  automations_json: SpaceDeletionAutomation[] | null;
  purge_step: string | null;
  purge_cursor: string | null;
  purged_rows: string | number;
  purged_objects: string | number;
  purge_started_at: Date | string | null;
  completed_at: Date | string | null;
  version: string | number;
}

export interface SpaceDeletionMember {
  userId: string;
  role: "owner" | "admin" | "member" | "viewer" | "participant";
  version: number;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

/** An Automation that was enabled when the Space was scheduled for deletion. */
export interface SpaceDeletionAutomation {
  automationId: string;
  version: number;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export function serializeSpaceDeletion(row: SpaceDeletionRow): Record<string, unknown> {
  return {
    spaceId: row.space_id,
    spaceName: row.space_name,
    ownerUserId: row.owner_user_id,
    state: row.state,
    requestedAt: iso(row.requested_at),
    purgeAfter: iso(row.purge_after),
    ...(row.purge_started_at ? { purgeStartedAt: iso(row.purge_started_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    purgedRows: Number(row.purged_rows),
    purgedObjects: Number(row.purged_objects),
  };
}

const DELETION_COLUMNS = `space_id,space_name,owner_user_id,requested_at,purge_after,state,
  members_json,automations_json,purge_step,purge_cursor,purged_rows,purged_objects,
  purge_started_at,completed_at,version`;

export async function lockSpaceDeletion(
  transaction: DatabaseTransaction,
  spaceId: string,
): Promise<SpaceDeletionRow | undefined> {
  return (await transaction.query<SpaceDeletionRow>({
    name: "space_deletion_lock_v1",
    text: `SELECT ${DELETION_COLUMNS} FROM data.space_deletions WHERE space_id=$1 FOR UPDATE`,
    values: [spaceId], maxRows: 1,
  }))[0];
}

export async function readSpaceDeletion(
  transaction: DatabaseTransaction,
  spaceId: string,
): Promise<(Record<string, unknown> & { state: SpaceDeletionState }) | null> {
  const row = (await transaction.query<SpaceDeletionRow>({
    name: "space_deletion_read_v1",
    text: `SELECT ${DELETION_COLUMNS} FROM data.space_deletions WHERE space_id=$1`,
    values: [spaceId], maxRows: 1,
  }))[0];
  return row ? { ...serializeSpaceDeletion(row), state: row.state } : null;
}

/**
 * A Space being deleted has no members, so ordinary access already fails
 * closed. The paths that could add a member back check this first.
 */
export async function isSpaceDeletionPending(
  transaction: DatabaseTransaction,
  spaceId: string,
): Promise<boolean> {
  return (await transaction.query({
    name: "space_deletion_pending_v1",
    text: "SELECT 1 FROM data.space_deletions WHERE space_id=$1 AND state<>'completed' LIMIT 1",
    values: [spaceId], maxRows: 1,
  })).length > 0;
}

export async function listScheduledSpaceDeletions(
  transaction: DatabaseTransaction,
  ownerUserId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await transaction.query<SpaceDeletionRow>({
    name: "space_deletion_owner_list_v1",
    text: `SELECT ${DELETION_COLUMNS} FROM data.space_deletions
      WHERE owner_user_id=$1 AND state='scheduled'
      ORDER BY requested_at DESC, space_id LIMIT 200`,
    values: [ownerUserId], maxRows: 200,
  });
  return rows.map(serializeSpaceDeletion);
}

/**
 * Removes every membership and pauses every enabled Automation, keeping both
 * as restore evidence. The caller holds the Space row lock and has proven the
 * actor is its owner.
 */
export async function scheduleSpaceDeletion(
  transaction: DatabaseTransaction,
  input: {
    spaceId: string; spaceName: string; ownerUserId: string; at: string; commitSequence: number;
  },
): Promise<{ deletion: Record<string, unknown>; members: SpaceDeletionMember[] }> {
  const { spaceId, at } = input;
  const memberRows = await transaction.query<QueryResultRow & {
    user_id: string; role: SpaceDeletionMember["role"]; version: string | number;
    email: string | null; display_name: string | null; avatar_url: string | null;
    created_at: Date | string;
  }>({
    name: "space_deletion_member_snapshot_v1",
    text: `SELECT user_id,role,version,email,display_name,avatar_url,created_at
      FROM data.space_members WHERE space_id=$1 ORDER BY user_id LIMIT ${SPACE_DELETION_MEMBER_MAX + 1}`,
    values: [spaceId], maxRows: SPACE_DELETION_MEMBER_MAX + 1,
  });
  if (memberRows.length > SPACE_DELETION_MEMBER_MAX) {
    throw new SpaceControlError("conflict", 409, "Space has too many members to delete at once");
  }
  const members = memberRows.map((row): SpaceDeletionMember => ({
    userId: row.user_id, role: row.role, version: Number(row.version),
    email: row.email, displayName: row.display_name, avatarUrl: row.avatar_url,
    createdAt: iso(row.created_at),
  }));
  const automations = (await transaction.query<QueryResultRow & {
    automation_id: string; version: string | number;
  }>({
    name: "space_deletion_automation_pause_v1",
    text: `UPDATE data.automations SET enabled=false, version=version+1, updated_at=$2
      WHERE enabled AND channel_id IN (SELECT channel_id FROM data.channels WHERE space_id=$1)
      RETURNING automation_id, version`,
    values: [spaceId, at], maxRows: SPACE_DELETION_AUTOMATION_MAX,
  })).map((row): SpaceDeletionAutomation => ({
    automationId: row.automation_id, version: Number(row.version),
  }));
  for (const [name, table] of [
    ["space_deletion_invites_v1", "data.space_invites"],
    ["space_deletion_join_requests_v1", "data.space_join_requests"],
    ["space_deletion_members_v1", "data.space_members"],
    ["space_deletion_membership_directory_v1", "control.user_space_memberships"],
  ] as const) {
    await transaction.query({
      name, text: `DELETE FROM ${table} WHERE space_id=$1`, values: [spaceId], maxRows: 0,
    });
  }
  await transaction.query({
    name: "space_deletion_membership_routes_v1",
    text: `UPDATE control.user_space_membership_routes SET state='deleted',
        membership_version=GREATEST(membership_version+1,$2),
        route_version=GREATEST(route_version+1,$2),updated_at=$3
      WHERE space_id=$1`,
    values: [spaceId, input.commitSequence, at], maxRows: 0,
  });
  const purgeAfter = new Date(Date.parse(at) + SPACE_DELETION_RESTORE_WINDOW_MS).toISOString();
  const inserted = await transaction.query<SpaceDeletionRow>({
    name: "space_deletion_schedule_v1",
    text: `INSERT INTO data.space_deletions
        (space_id,space_name,owner_user_id,requested_at,purge_after,state,members_json,
         automations_json,purge_step,purge_cursor,purged_rows,purged_objects,
         purge_started_at,completed_at,version,updated_at)
      VALUES ($1,$2,$3,$4,$5,'scheduled',$6::jsonb,$7::jsonb,NULL,NULL,0,0,NULL,NULL,1,$4)
      RETURNING ${DELETION_COLUMNS}`,
    values: [spaceId, input.spaceName.slice(0, 200), input.ownerUserId, at, purgeAfter,
      JSON.stringify(members), JSON.stringify(automations)],
    maxRows: 1,
  });
  return { deletion: serializeSpaceDeletion(inserted[0]!), members };
}

/** Reverses a scheduled deletion. Stopped Runs stay stopped. */
export async function restoreSpaceDeletion(
  transaction: DatabaseTransaction,
  input: {
    deletion: SpaceDeletionRow; at: string; commitSequence: number;
    deletedUserIds?: readonly string[];
    placement: { shardId: string; placementEpoch: number };
  },
): Promise<SpaceDeletionMember[]> {
  const { deletion, at } = input;
  const spaceId = deletion.space_id;
  const members = (deletion.members_json ?? []).filter(member => !input.deletedUserIds?.includes(member.userId));
  for (const member of members) {
    await insertSpaceMember(transaction, {
      name: "space_restore_member_v1", spaceId, userId: member.userId,
      role: member.role, version: member.version + 1, email: member.email,
      displayName: member.displayName, avatarUrl: member.avatarUrl,
      createdAt: member.createdAt, updatedAt: at,
    });
    await transaction.query({
      name: "space_restore_membership_directory_v1",
      text: `INSERT INTO control.user_space_memberships
          (user_id,space_id,role,membership_version,updated_at)
        VALUES ($1,$2,$3,$4,$5)`,
      values: [member.userId, spaceId, member.role, member.version + 1, at],
      maxRows: 0,
    });
    await transaction.query({
      name: "space_restore_membership_route_v1",
      text: `INSERT INTO control.user_space_membership_routes
          (user_id,space_id,role,shard_id,placement_epoch,membership_version,route_version,state,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)
        ON CONFLICT (user_id,space_id) DO UPDATE SET state='active', role=EXCLUDED.role,
          shard_id=EXCLUDED.shard_id, placement_epoch=EXCLUDED.placement_epoch,
          membership_version=GREATEST(control.user_space_membership_routes.membership_version+1,
            EXCLUDED.membership_version),
          route_version=GREATEST(control.user_space_membership_routes.route_version+1,
            EXCLUDED.route_version),
          updated_at=EXCLUDED.updated_at`,
      values: [member.userId, spaceId, member.role, input.placement.shardId,
        input.placement.placementEpoch, member.version + 1, input.commitSequence, at],
      maxRows: 0,
    });
  }
  for (const automation of deletion.automations_json ?? []) {
    // An Automation someone changed since it was paused keeps its current state.
    await transaction.query({
      name: "space_restore_automation_v1",
      text: `UPDATE data.automations SET enabled=true, version=version+1, updated_at=$3
        WHERE automation_id=$1 AND version=$2 AND NOT enabled AND NOT (owner_user_id=ANY($4::text[]))`,
      values: [automation.automationId, automation.version, at, input.deletedUserIds ?? []], maxRows: 0,
    });
  }
  await transaction.query({
    name: "space_restore_deletion_v1",
    text: "DELETE FROM data.space_deletions WHERE space_id=$1 AND state='scheduled'",
    values: [spaceId], maxRows: 0,
  });
  return members;
}

const SPACE_CHANNELS = "(SELECT channel_id FROM data.channels WHERE space_id=$1)";

/**
 * Every row a deleted Space owns, removed in this order. Channel-keyed facts
 * go before the Channels that locate them; the Space row, its head and its
 * placement go last in the finalizing transaction. The classification test
 * fails when a table with a Space or Channel key is missing from this list and
 * from SPACE_PURGE_EXCLUDED_TABLES.
 */
export const SPACE_PURGE_STEPS: readonly { table: string; predicate: string }[] = Object.freeze([
  { table: "data.automation_occurrences", predicate:
    `automation_id IN (SELECT automation_id FROM data.automations WHERE channel_id IN ${SPACE_CHANNELS})` },
  { table: "data.automations", predicate: `channel_id IN ${SPACE_CHANNELS}` },
  ...[
    "data.instances", "data.runs", "data.natural_key_counters", "data.natural_key_reservations",
    "data.machine_run_routes", "data.machine_run_snapshot_heads", "data.machine_run_terminal_reports",
    "data.trace_access_grants",
  ].map((table) => ({ table, predicate: `channel_id IN ${SPACE_CHANNELS}` })),
  ...["data.extension_records", "control.scoped_control_command_replays"]
    .map((table) => ({ table, predicate: "scope_kind='space' AND scope_id=$1" })),
  ...["data.projection_manifest_grants", "data.projection_scope_heads"].map((table) => ({
    table,
    predicate: `visibility_scope_id='space:'||$1
      OR visibility_scope_id IN (SELECT 'channel:'||channel_id FROM data.channels WHERE space_id=$1)`,
  })),
  { table: "data.cross_space_read_grants", predicate: "space_id=$1 OR source_space_id=$1" },
  { table: "data.channel_transfer_proposals", predicate: "space_id=$1 OR target_space_id=$1" },
  ...[
    "data.agent_launches", "data.agent_message_executions", "data.agent_reborn_intents",
    "data.agent_registration_commands",
    "data.app_connector_action_policies", "data.app_connector_channel_bindings", "data.app_connector_connections",
    "data.app_connector_credentials", "data.app_connector_oauth_installations",
    "data.app_wecom_install_attempts", "data.app_wecom_installations",
    "data.app_teams_link_attempts", "data.app_teams_room_bindings",
    "data.app_googlechat_link_attempts", "data.app_googlechat_room_bindings",
    "data.app_connector_executions", "data.app_source_relations", "data.blob_upload_intents",
    "data.channel_metadata_revisions", "data.channel_about_inputs",
    "data.channel_access", "data.channel_content_counters", "data.channel_message_sequences",
    "data.content_gc_candidates", "data.content_objects",
    "data.content_refs", "data.cross_space_read_notices", "data.delivery_cursors", "data.first_message_launch_choices",
    "data.message_annotations",
    "data.message_attachment_refs", "data.message_attachments", "data.message_attention",
    "data.message_attention_revisions", "data.message_mutations", "data.message_reactions",
    "data.message_sequence_reservations", "data.messages", "data.page_access", "data.page_block_competitions",
    "data.page_claims", "data.page_links", "data.page_migrations", "data.page_reads",
    "data.page_revisions", "data.pages", "data.registration_access_changes",
    "data.registration_launch_intents", "data.registration_stop_intents", "data.retired_agent_dm_purges",
    "data.retired_direct_conversation_purges",
    "data.run_agent_registrations", "data.space_action_claims",
    "data.space_agent_registration_access", "data.space_agent_registrations",
    "data.space_billing_checkout_intents",
    "data.space_billing_subscriptions", "data.space_billing_usage", "data.space_billing_webhook_events",
    "data.space_invites", "data.space_join_requests",
    "data.space_member_creation_policies", "data.space_members",
    "data.space_secrets", "data.run_secret_approvals",
    "data.space_storage_usage", "data.user_space_channel_view_preferences",
    "data.user_space_locale_preferences", "data.idempotency_keys", "data.outbox",
    "control.agent_registration_enrollments", "control.channel_space_directory",
    "control.channel_space_routes", "control.entity_space_routes",
    "control.registration_execution_allocations",
    "control.registration_preparation_cancellations", "control.user_space_membership_routes",
    "control.user_space_memberships", "control.space_shard_movements",
  ].map((table) => ({ table, predicate: "space_id=$1" })),
  { table: "data.channels", predicate: "space_id=$1" },
]);

/**
 * Space- or Channel-keyed tables the purge deliberately does not empty. The
 * purge test checks every keyed table is either purged or listed here.
 * @testonly
 */
export const SPACE_PURGE_EXCLUDED_TABLES: Readonly<Record<string, string>> = Object.freeze({
  "data.spaces": "removed by the finalizing transaction",
  "data.space_control_heads": "removed by the finalizing transaction",
  "control.space_placement": "removed by the finalizing transaction",
  "data.space_deletions": "the audit record of the deletion itself",
});

function stepName(index: number): string {
  return `rows:${SPACE_PURGE_STEPS[index]!.table}`;
}

function stepIndex(step: string | null): number {
  if (!step?.startsWith("rows:")) return 0;
  const index = SPACE_PURGE_STEPS.findIndex((entry) => `rows:${entry.table}` === step);
  if (index < 0) throw new SpaceControlError("space_purge_step_unknown", 500, "Space purge step is unknown");
  return index;
}

export type SpacePurgeStep =
  | { status: "absent" }
  | { status: "completed"; deletion: Record<string, unknown> }
  | { status: "restorable"; purgeAfter: string }
  | { status: "objects"; objectKeys: string[]; cursor: string; exhausted: boolean }
  | { status: "rows"; purgedRows: number }
  | { status: "finalize" };

/** Starts the purge once the restore window is over. Restore evidence goes with it. */
async function beginPurge(transaction: DatabaseTransaction, deletion: SpaceDeletionRow, now: string) {
  await transaction.query({
    name: "space_purge_begin_v1",
    text: `UPDATE data.space_deletions SET state='purging', members_json=NULL, automations_json=NULL,
        purge_step='objects', purge_cursor=NULL, purge_started_at=$2, version=version+1, updated_at=$2
      WHERE space_id=$1 AND state='scheduled'`,
    values: [deletion.space_id, now], maxRows: 0,
  });
  deletion.state = "purging";
  deletion.purge_step = "objects";
  deletion.purge_cursor = null;
}

/**
 * Reads the next step of a due purge. Object steps return R2 keys for the
 * caller to delete outside the transaction and then record with
 * {@link recordSpacePurgeObjects}; row steps delete one bounded batch here.
 */
export async function nextSpacePurgeStep(
  transaction: DatabaseTransaction,
  input: { spaceId: string; now: string },
): Promise<SpacePurgeStep> {
  const deletion = await lockSpaceDeletion(transaction, input.spaceId);
  if (!deletion) return { status: "absent" };
  if (deletion.state === "completed") return { status: "completed", deletion: serializeSpaceDeletion(deletion) };
  if (deletion.state === "scheduled") {
    if (Date.parse(iso(deletion.purge_after)) > Date.parse(input.now)) {
      return { status: "restorable", purgeAfter: iso(deletion.purge_after) };
    }
    await beginPurge(transaction, deletion, input.now);
  }
  if (deletion.purge_step === "objects") {
    return spacePurgeObjects(transaction, input.spaceId, deletion.purge_cursor ?? "");
  }
  if (deletion.purge_step === "finalize") return { status: "finalize" };
  let index = stepIndex(deletion.purge_step);
  let purgedRows = 0;
  while (index < SPACE_PURGE_STEPS.length && purgedRows < PURGE_STEP_ROW_BUDGET) {
    const { table, predicate } = SPACE_PURGE_STEPS[index]!;
    const deleted = await transaction.query({
      name: `space_purge_${table.replace(".", "_")}_v1`,
      text: `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(
          SELECT ctid FROM ${table} WHERE ${predicate} LIMIT ${PURGE_BATCH_ROWS}))
        RETURNING 1`,
      values: [input.spaceId], maxRows: PURGE_BATCH_ROWS,
    });
    purgedRows += deleted.length;
    if (deleted.length < PURGE_BATCH_ROWS) index++;
  }
  await transaction.query({
    name: "space_purge_rows_progress_v1",
    text: `UPDATE data.space_deletions SET purge_step=$2, purged_rows=purged_rows+$3,
        version=version+1, updated_at=$4
      WHERE space_id=$1 AND state='purging'`,
    values: [input.spaceId, index < SPACE_PURGE_STEPS.length ? stepName(index) : "finalize",
      purgedRows, input.now],
    maxRows: 0,
  });
  return { status: "rows", purgedRows };
}

/**
 * Restricted content keys are scoped to one Channel and reader, so a key whose
 * Channel belongs to this Space is exactly this Space's bytes. Unrestricted
 * `objects/<sha256>` keys are content-addressed and may be shared with other
 * Spaces; they lose every reference here and are never deleted by a Space purge.
 */
async function spacePurgeObjects(
  transaction: DatabaseTransaction,
  spaceId: string,
  cursor: string,
): Promise<SpacePurgeStep> {
  const rows = await transaction.query<QueryResultRow & { key: string }>({
    name: "space_purge_object_keys_v1",
    text: `SELECT key FROM (
        SELECT storage_key AS key FROM data.content_objects WHERE space_id=$1
        UNION SELECT object_key FROM data.message_attachments WHERE space_id=$1
        UNION SELECT object_key FROM data.blob_upload_intents WHERE space_id=$1
        UNION SELECT storage_key FROM data.content_gc_candidates WHERE space_id=$1
      ) keys WHERE key LIKE 'restricted/%' AND key > $2 ORDER BY key LIMIT ${PURGE_OBJECT_BATCH}`,
    values: [spaceId, cursor], maxRows: PURGE_OBJECT_BATCH,
  });
  const scoped = rows.map((row) => ({ key: row.key, channelId: restrictedKeyChannel(row.key) }));
  const channelIds = [...new Set(scoped.flatMap((row) => row.channelId ? [row.channelId] : []))];
  const owned = new Set((channelIds.length ? await transaction.query<QueryResultRow & { channel_id: string }>({
    name: "space_purge_object_channels_v1",
    text: "SELECT channel_id FROM data.channels WHERE space_id=$1 AND channel_id = ANY($2::text[])",
    values: [spaceId, channelIds], maxRows: PURGE_OBJECT_BATCH,
  }) : []).map((row) => row.channel_id));
  return {
    status: "objects",
    objectKeys: scoped.filter((row) => row.channelId && owned.has(row.channelId)).map((row) => row.key),
    cursor: rows.at(-1)?.key ?? cursor,
    exhausted: rows.length < PURGE_OBJECT_BATCH,
  };
}

function restrictedKeyChannel(key: string): string | null {
  const parts = /^restricted\/([^/]+)\/objects\/[a-f0-9]{64}$/u.exec(key);
  if (!parts) return null;
  try {
    return parseRestrictedChannelContentScope(decodeURIComponent(parts[1]!))?.channelId ?? null;
  } catch {
    return null;
  }
}

export async function recordSpacePurgeObjects(
  transaction: DatabaseTransaction,
  input: { spaceId: string; cursor: string; exhausted: boolean; deleted: number; now: string },
): Promise<boolean> {
  const updated = await transaction.query({
    name: "space_purge_objects_progress_v1",
    text: `UPDATE data.space_deletions SET purge_step=$2, purge_cursor=CASE WHEN $6 THEN NULL ELSE $3 END,
        purged_objects=purged_objects+$4, version=version+1, updated_at=$5
      WHERE space_id=$1 AND state='purging' AND purge_step='objects'
        AND COALESCE(purge_cursor,'') <= $3
      RETURNING space_id`,
    values: [input.spaceId, input.exhausted ? stepName(0) : "objects",
      input.cursor, input.deleted, input.now, input.exhausted],
    maxRows: 1,
  });
  return updated.length > 0;
}

/** Removes the Space row, its head and placement, and completes the audit record. */
export async function finalizeSpacePurge(
  transaction: DatabaseTransaction,
  input: { spaceId: string; now: string },
): Promise<Record<string, unknown> | null> {
  const deletion = await lockSpaceDeletion(transaction, input.spaceId);
  if (!deletion || deletion.state !== "purging" || deletion.purge_step !== "finalize") return null;
  let purgedRows = 0;
  for (const [name, table] of [
    ["space_purge_final_space_v1", "data.spaces"],
    ["space_purge_final_head_v1", "data.space_control_heads"],
    ["space_purge_final_placement_v1", "control.space_placement"],
  ] as const) {
    purgedRows += (await transaction.query({
      name, text: `DELETE FROM ${table} WHERE space_id=$1 RETURNING 1`,
      values: [input.spaceId], maxRows: 1,
    })).length;
  }
  const completed = await transaction.query<SpaceDeletionRow>({
    name: "space_purge_complete_v1",
    text: `UPDATE data.space_deletions SET state='completed', purge_step=NULL, purge_cursor=NULL,
        purged_rows=purged_rows+$2, completed_at=$3, version=version+1, updated_at=$3
      WHERE space_id=$1 RETURNING ${DELETION_COLUMNS}`,
    values: [input.spaceId, purgedRows, input.now], maxRows: 1,
  });
  return serializeSpaceDeletion(completed[0]!);
}

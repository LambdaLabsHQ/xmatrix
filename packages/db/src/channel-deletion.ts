import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { SpaceControlError } from "./space-control.js";
import { ACTIVE_RUN_STATUS_SQL, parseRestrictedChannelContentScope } from "@xmatrix/protocol";

const RUNS = "(SELECT run_id FROM data.runs WHERE channel_id=$2)";
const INSTANCES = "(SELECT instance_id FROM data.instances WHERE channel_id=$2)";
const CONTENT_SCOPE = "(root_set_id='channel:'||$2 OR starts_with(root_set_id,$3))";
const UPLOAD_SCOPE = "(scope_id='channel:'||$2 OR starts_with(scope_id,$3))";
// Match the narrow GIN expressions in the Channel replay lookup migration.
// An OR across unindexed JSON paths scanned every receipt for every batch,
// repeatedly exhausting the deadline and rolling back all prior progress.
const REPLAY_CHANNEL_IDS = "result_json->>'channelId', result_json->'message'->>'channelId', result_json->'channel'->>'id', result_json->'task'->>'channelId'";
const REPLAY_CHANNEL = `ARRAY[${REPLAY_CHANNEL_IDS}] @> ARRAY[$2]`;

/** Order preserves the identities needed to find indirectly owned records. */
export const CHANNEL_PURGE_STEPS: readonly { table: string; predicate: string }[] = [
  { table: "data.automation_occurrences", predicate:
    "automation_id IN (SELECT automation_id FROM data.automations WHERE channel_id=$2)" },
  { table: "data.automations", predicate: "channel_id=$2" },
  ...["data.run_agent_registrations", "data.run_secret_approvals",
    "control.registration_execution_allocations", "control.registration_preparation_cancellations"]
    .map(table => ({ table, predicate: `run_id IN ${RUNS}` })),
  { table: "control.entity_space_routes", predicate:
    `(entity_kind='instance' AND entity_id IN ${INSTANCES})` },
  { table: "data.cross_space_read_grants", predicate:
    `channel_id=$2 OR source_channel_id=$2 OR run_id IN ${RUNS}` },
  ...["data.page_links", "data.page_claims", "data.page_co_writing"]
    .map(table => ({ table, predicate: "conversation_id=$2" })),
  { table: "control.scoped_control_command_replays", predicate:
    `ARRAY[CASE WHEN scope_kind='channel' THEN scope_id END, ${REPLAY_CHANNEL_IDS}] @> ARRAY[$2]` },
  { table: "data.content_refs", predicate: `space_id=$1 AND ${CONTENT_SCOPE}` },
  { table: "data.blob_upload_intents", predicate: `space_id=$1 AND ${UPLOAD_SCOPE}` },
  ...["data.content_objects", "data.content_gc_candidates"]
    .map(table => ({ table, predicate: "space_id=$1 AND starts_with(storage_key,$4)" })),
  ...[
    "data.agent_launches", "data.agent_message_executions", "data.agent_reborn_intents",
    "data.app_connector_action_requests", "data.app_connector_action_policies",
    "data.app_connector_executions", "data.app_source_relations",
    "data.registration_launch_intents", "data.registration_stop_intents",
    "data.channel_access", "data.channel_content_counters", "data.channel_message_sequences",
    "data.channel_metadata_revisions", "data.channel_transfer_proposals",
    "data.cross_space_read_notices", "data.delivery_cursors", "data.first_message_launch_choices",
    "data.message_annotations", "data.message_attachment_refs", "data.message_attachments",
    "data.message_attention", "data.message_attention_revisions", "data.message_mutations",
    "data.message_reactions", "data.message_sequence_reservations", "data.messages",
    "data.machine_run_routes", "data.machine_run_snapshot_heads", "data.machine_run_terminal_reports",
    "data.trace_access_grants", "data.natural_key_counters", "data.natural_key_reservations",
    "data.instances", "data.runs",
  ].map(table => ({ table, predicate: "channel_id=$2" })),
  // Message receipts and outbox rows may contain replay copies of erased bytes.
  { table: "data.idempotency_keys", predicate:
    REPLAY_CHANNEL },
  { table: "data.outbox", predicate:
    `ARRAY[CASE WHEN aggregate_kind='channel' THEN aggregate_id END, ${REPLAY_CHANNEL_IDS.replaceAll("result_json", "payload_json")}] @> ARRAY[$2]` },
];

export interface ChannelDeletionRow extends QueryResultRow {
  space_id: string; channel_id: string; state: "purging" | "completed";
  step: number; object_cursor: string; objects_done: boolean;
}

export async function retireChannel(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; actorUserId: string; name: string; at: string;
}): Promise<{ state: "purging" | "completed" }> {
  const prior = await tx.query<ChannelDeletionRow>({ name: "channel_deletion_existing_v1",
    text: "SELECT state FROM data.channel_deletions WHERE space_id=$1 AND channel_id=$2",
    values: [input.spaceId, input.channelId], maxRows: 1 });
  if (prior[0]) return { state: prior[0].state };
  const [channel] = await tx.query<{ name: string; mode: string }>({
    name: "channel_deletion_lock_v1", text: `SELECT name,mode FROM data.channels
      WHERE space_id=$1 AND channel_id=$2 FOR UPDATE`, values: [input.spaceId, input.channelId], maxRows: 1 });
  if (!channel || channel.mode === "deleted") throw new SpaceControlError("channel_not_found", 404, "Channel not found");
  if (channel.name !== input.name)
    throw new SpaceControlError("channel_deletion_changed", 409, "The Channel changed. Reload it and confirm its current name.");
  const busy = await tx.query({ name: "channel_deletion_busy_v1", text: `SELECT 1 WHERE $1::text IS NOT NULL AND (EXISTS (
      SELECT 1 FROM data.runs WHERE channel_id=$2 AND status IN (${ACTIVE_RUN_STATUS_SQL}))
      OR EXISTS (SELECT 1 FROM control.registration_execution_allocations WHERE run_id IN ${RUNS} AND state<>'released')
      OR EXISTS (SELECT 1 FROM data.agent_launches WHERE channel_id=$2 AND state IN ('prepared','queued','admitted','spawned')))`,
    values: [input.spaceId, input.channelId], maxRows: 1 });
  if (busy.length) throw new SpaceControlError("channel_deletion_active_work", 409,
    "Stop the Agents in this Channel and wait for them to finish before deleting it.");
  await tx.query({ name: "channel_deletion_retire_v1", text: `UPDATE data.channels SET mode='deleted',
      version=version+1,metadata_json=NULL,updated_at=$3 WHERE space_id=$1 AND channel_id=$2`,
    values: [input.spaceId, input.channelId, input.at], maxRows: 0 });
  await tx.query({ name: "channel_deletion_record_v1", text: `INSERT INTO data.channel_deletions
      (space_id,channel_id,requested_by,requested_at,updated_at,state) VALUES ($1,$2,$3,$4,$4,'purging')`,
    values: [input.spaceId, input.channelId, input.actorUserId, input.at], maxRows: 0 });
  return { state: "purging" };
}

/** A restart or concurrent worker repeats only an exact bounded batch. */
export async function purgeChannelRows(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; at: string;
}): Promise<boolean> {
  const [job] = await tx.query<ChannelDeletionRow>({ name: "channel_purge_lock_v1",
    text: "SELECT * FROM data.channel_deletions WHERE space_id=$1 AND channel_id=$2 FOR UPDATE",
    values: [input.spaceId, input.channelId], maxRows: 1 });
  if (!job || job.state === "completed") return true;
  if (!job.objects_done) return false;
  await assertRetiredChannel(tx, input.spaceId, input.channelId);
  const pins = await tx.query({ name: "channel_purge_pins_v1", text: `UPDATE data.user_space_channel_view_preferences
    SET pinned_channel_ids_json=pinned_channel_ids_json-$2,version=version+1,updated_at=$3
    WHERE ctid IN (SELECT ctid FROM data.user_space_channel_view_preferences
      WHERE space_id=$1 AND pinned_channel_ids_json ? $2 LIMIT 500) RETURNING 1`,
    values: [input.spaceId, input.channelId, input.at], maxRows: 500 });
  // Deleted rows are progress. Revisiting the finite plan also handles new
  // dependency steps inserted before a marker retained by an older release.
  let step = 0, removed = pins.length;
  while (step < CHANNEL_PURGE_STEPS.length && removed < 2_000) {
    const { table, predicate } = CHANNEL_PURGE_STEPS[step]!;
    const limit = Math.min(500, 2_000 - removed);
    const rows = await tx.query({ name: `channel_purge_${table.replace(".", "_")}_v1`, text:
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table}
        WHERE (${predicate}) AND $1::text IS NOT NULL AND $2::text IS NOT NULL
          AND $3::text IS NOT NULL AND $4::text IS NOT NULL LIMIT $5) RETURNING 1`,
      values: [input.spaceId, input.channelId, restrictedPrefix(input.channelId), objectPrefix(input.channelId), limit], maxRows: limit });
    removed += rows.length;
    if (rows.length < limit) step++;
  }
  const complete = step === CHANNEL_PURGE_STEPS.length && pins.length < 500;
  if (complete) await tx.query({ name: "channel_purge_channel_v1",
    text: "DELETE FROM data.channels WHERE space_id=$1 AND channel_id=$2 AND mode='deleted'",
    values: [input.spaceId, input.channelId], maxRows: 0 });
  await tx.query({ name: "channel_purge_progress_v1", text: `UPDATE data.channel_deletions SET
      step=$3,purged_rows=purged_rows+$4,updated_at=$5,state=$6,
      completed_at=CASE WHEN $6='completed' THEN $5::timestamptz ELSE NULL END
      WHERE space_id=$1 AND channel_id=$2`,
    values: [input.spaceId, input.channelId, step, removed, input.at, complete ? "completed" : "purging"], maxRows: 0 });
  return complete;
}

export async function channelPurgeObjects(tx: DatabaseTransaction, spaceId: string, channelId: string) {
  const [job] = await tx.query<ChannelDeletionRow>({ name: "channel_purge_object_job_v1",
    text: "SELECT * FROM data.channel_deletions WHERE space_id=$1 AND channel_id=$2",
    values: [spaceId, channelId], maxRows: 1 });
  if (!job || job.state === "completed" || job.objects_done) return null;
  await assertRetiredChannel(tx, spaceId, channelId);
  const rows = await tx.query<{ key: string }>({ name: "channel_purge_object_keys_v1", text: `SELECT key FROM (
      SELECT storage_key AS key FROM data.content_objects WHERE space_id=$1 AND starts_with(storage_key,$4)
      UNION SELECT object_key FROM data.message_attachments WHERE space_id=$1 AND channel_id=$2
      UNION SELECT object_key FROM data.blob_upload_intents WHERE space_id=$1 AND ${UPLOAD_SCOPE.replaceAll("$3", "$5")}
      UNION SELECT storage_key FROM data.content_gc_candidates WHERE space_id=$1 AND starts_with(storage_key,$4)
    ) keys WHERE key LIKE 'restricted/%' AND key>$3 ORDER BY key LIMIT 100`,
    values: [spaceId, channelId, job.object_cursor, objectPrefix(channelId), restrictedPrefix(channelId)], maxRows: 100 });
  const keys = rows.flatMap(({ key }) => {
    const match = /^restricted\/([^/]+)\/objects\/[a-f0-9]{64}$/u.exec(key);
    if (!match) return [];
    try { return parseRestrictedChannelContentScope(decodeURIComponent(match[1]!))?.channelId === channelId ? [key] : []; }
    catch { return []; }
  });
  return { keys, previousCursor: job.object_cursor, cursor: rows.at(-1)?.key ?? job.object_cursor,
    done: rows.length < 100 };
}

function restrictedPrefix(channelId: string): string { return `channel-user:${encodeURIComponent(channelId)}:`; }
function objectPrefix(channelId: string): string { return `restricted/${encodeURIComponent(restrictedPrefix(channelId))}`; }

async function assertRetiredChannel(tx: DatabaseTransaction, spaceId: string, channelId: string): Promise<void> {
  const live = await tx.query({ name: "channel_purge_retirement_v1",
    text: "SELECT 1 FROM data.channels WHERE channel_id=$1 AND (space_id<>$2 OR mode<>'deleted') LIMIT 1",
    values: [channelId, spaceId], maxRows: 1 });
  if (live.length) throw new Error("Channel purge requires its exact retired identity");
}

export async function recordChannelPurgeObjects(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; previousCursor: string; cursor: string; done: boolean; at: string;
}): Promise<void> {
  await tx.query({ name: "channel_purge_objects_progress_v1", text: `UPDATE data.channel_deletions
    SET object_cursor=$4,objects_done=$5,updated_at=$6 WHERE space_id=$1 AND channel_id=$2
      AND object_cursor=$3 AND NOT objects_done AND state='purging'`,
    values: [input.spaceId, input.channelId, input.previousCursor, input.cursor, input.done, input.at], maxRows: 0 });
}

import type { DatabaseTransaction } from "./contracts.js";

// Only private account/control material. Shared work, billing evidence, and
// audit history stay with their Space; scheduled Space purges run independently.
const PRIVATE_ROWS = [
  ["data.human_profiles", "user_id"],
  ["data.user_space_locale_preferences", "user_id"],
  ["data.user_space_channel_view_preferences", "user_id"],
  ["data.machine_resource_samples", "owner_user_id"],
  ["data.machine_resource_hourly", "owner_user_id"],
  ["data.machine_daemon_commands", "owner_user_id"],
  ["data.machine_daemon_activations", "daemon_id"],
  ["data.machine_daemons", "owner_user_id"],
  ["control.agent_environment_commands", "owner_user_id"],
  ["control.registration_quota_observations", "owner_user_id"],
  ["control.agent_registration_enrollments", "owner_user_id"],
  ["data.assistant_memory_snapshots", "owner_user_id"],
  ["data.shared_memory_workspace_entries", "owner_user_id"],
  ["data.roles", "owner_user_id"],
  ["data.workspaces", "owner_user_id"],
  ["data.machines", "owner_user_id"],
] as const;

/** At most 2,000 private rows per physical shard per pass; safe to replay. */
export async function erasePrivateAccountRows(tx: DatabaseTransaction, userId: string): Promise<boolean> {
  const profiles = await tx.query<{ count: number }>({ name: "account_erase_join_profiles_v1", text: `WITH scrubbed AS (
    UPDATE data.space_join_requests SET email=NULL,display_name=NULL,avatar_url=NULL,version=version+1
      WHERE ctid IN (SELECT ctid FROM data.space_join_requests WHERE user_id=$1
        AND (email IS NOT NULL OR display_name IS NOT NULL OR avatar_url IS NOT NULL) LIMIT 500)
      RETURNING 1) SELECT count(*)::int AS count FROM scrubbed`, values: [userId], maxRows: 1 });
  let removed = Number(profiles[0]?.count ?? 0);
  if (removed === 500) return false;
  // Restore evidence can hold up to 9,999 members per Space. Process only five
  // snapshots per pass, removing this identity and preserving other members.
  const restored = await tx.query<{ count: number }>({ name: "account_erase_restore_profiles_v1", text: `WITH scrubbed AS (
    UPDATE data.space_deletions SET members_json=COALESCE(
        (SELECT jsonb_agg(member ORDER BY ordinal) FROM jsonb_array_elements(members_json) WITH ORDINALITY AS entries(member,ordinal)
          WHERE member->>'userId' IS DISTINCT FROM $1),'[]'::jsonb),version=version+1,updated_at=clock_timestamp()
      WHERE state='scheduled' AND members_json @> jsonb_build_array(jsonb_build_object('userId',$1::text))
        AND ctid IN (SELECT ctid FROM data.space_deletions WHERE state='scheduled'
          AND members_json @> jsonb_build_array(jsonb_build_object('userId',$1::text)) LIMIT 5)
      RETURNING 1) SELECT count(*)::int AS count FROM scrubbed`, values: [userId], maxRows: 1 });
  const restoreCount = Number(restored[0]?.count ?? 0);
  removed += restoreCount;
  if (restoreCount === 5) return false;
  const scrubbed = await tx.query<{ count: number }>({ name: "account_erase_environment_v1", text: `WITH scrubbed AS (
    UPDATE control.agent_registration_environments
      SET declaration_json='{"workspaces":[],"models":[],"capabilities":[]}'::jsonb,version=version+1,updated_at=clock_timestamp()
      WHERE ctid IN (SELECT ctid FROM control.agent_registration_environments WHERE owner_user_id=$1
        AND declaration_json<>'{"workspaces":[],"models":[],"capabilities":[]}'::jsonb LIMIT 500)
      RETURNING 1) SELECT count(*)::int AS count FROM scrubbed`, values: [userId], maxRows: 1 });
  const environmentCount = Number(scrubbed[0]?.count ?? 0);
  removed += environmentCount;
  if (environmentCount === 500) return false;
  for (const [table, column] of PRIVATE_ROWS) {
    const predicate = column === "daemon_id" ? "daemon_id IN (SELECT daemon_id FROM data.machine_daemons WHERE owner_user_id=$1)" : `${column}=$1`;
    const limit = Math.min(500, 2_000 - removed);
    const rows = await tx.query<{ count: number }>({ name: `account_erase_${table.replace(".", "_")}_v1`,
      text: `WITH erased AS (DELETE FROM ${table} WHERE ctid IN
        (SELECT ctid FROM ${table} WHERE ${predicate} LIMIT $2) RETURNING 1)
        SELECT count(*)::int AS count FROM erased`, values: [userId,limit], maxRows: 1 });
    const count = Number(rows[0]?.count ?? 0);
    removed += count;
    if (count === limit || removed >= 2_000) return false;
  }
  return true;
}

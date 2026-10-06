import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/**
 * A recall or delete erases the whole payload bundle, and the sender snapshot
 * travels inside it, so a tombstone keeps only its stable author id. History
 * would then name the author by that raw id. Resolve the current Space name
 * for those rows from the same shard, exactly as a send-time snapshot would:
 * a Human by their Space member name, an Agent Instance as `<name>:<ordinal>`.
 * Unresolved authors keep the id; nothing here widens what a reader can see.
 */
export async function hydrateTombstoneSenders(
  transaction: DatabaseTransaction,
  spaceId: string,
  rows: Array<{
    author_kind: string; author_id: string; payload_bundle_base64: string | null;
    tombstone_sender?: Record<string, unknown>;
  }>,
): Promise<void> {
  const tombstones = rows.filter((row) => row.payload_bundle_base64 === null &&
    (row.author_kind === "user" || row.author_kind === "agent"));
  if (tombstones.length === 0) return;
  const ids = (kind: string) => [...new Set(tombstones
    .filter((row) => row.author_kind === kind).map((row) => row.author_id))];
  const userIds = ids("user");
  const instanceIds = ids("agent");
  const found = await transaction.query<QueryResultRow & {
    author_kind: string; author_id: string; label: string | null; avatar_url: string | null;
    agent_name: string | null; channel_instance_id: string | number | null;
  }>({
    name: "message_history_tombstone_senders_v1",
    text: `SELECT 'user' AS author_kind, m.user_id AS author_id, m.display_name AS label,
          m.avatar_url, NULL::text AS agent_name, NULL::bigint AS channel_instance_id
        FROM data.space_members m WHERE m.space_id=$1 AND m.user_id=ANY($2::text[])
      UNION ALL
      SELECT 'agent', instance.instance_id,
          registration.display_name||':'||instance.channel_instance_id::text,
          NULL::text, registration.display_name, instance.channel_instance_id
        FROM data.instances instance
        JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
        JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
          AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
          AND registration.harness=binding.harness
        WHERE binding.space_id=$1 AND instance.instance_id=ANY($3::text[])`,
    values: [spaceId, userIds, instanceIds],
    maxRows: userIds.length + instanceIds.length,
  });
  const byAuthor = new Map(found.flatMap((row) => {
    const label = typeof row.label === "string" && row.label.trim() ? row.label : undefined;
    if (!label) return [];
    const sender: Record<string, unknown> = { label, name: row.agent_name ?? label };
    if (row.author_kind === "agent") {
      sender.agentName = row.agent_name;
      sender.instanceId = row.author_id;
      sender.channelInstanceId = String(row.channel_instance_id);
      sender.instanceLabel = label;
    } else {
      sender.userId = row.author_id;
      if (typeof row.avatar_url === "string" && row.avatar_url) sender.avatarUrl = row.avatar_url;
    }
    return [[`${row.author_kind}:${row.author_id}`, sender] as const];
  }));
  for (const row of tombstones) {
    const sender = byAuthor.get(`${row.author_kind}:${row.author_id}`);
    if (sender) row.tombstone_sender = sender;
  }
}

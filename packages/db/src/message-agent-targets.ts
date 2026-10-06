import type { QueryResultRow } from "pg";
import { existingInstanceMentionScanner, filterOperationalMentions, sha256Hex,
  type SerializedAgentMessageTarget , utf8ByteLength } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";

type Target = Omit<SerializedAgentMessageTarget, "channelId" | "sourceMessageId" | "sourceEntityVersion" | "sourceBodyHash" | "createdAt" | "runStatus" | "sourceInputVersion">;

/** Called only by the authorized append transaction, with its canonical body. */
export async function resolveMessageAgentTargets(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageId: string; body: string;
}): Promise<Target[] | undefined> {
  const matches = filterOperationalMentions(input.body, [...input.body.matchAll(existingInstanceMentionScanner())]
    .map(match => ({ start: match.index! + match[0].length - match[1]!.length - 1,
      name: match[1]!.slice(0, match[1]!.lastIndexOf(":")), ordinal: match[1]!.slice(match[1]!.lastIndexOf(":") + 1),
      address: match[0].slice(-match[1]!.length - 1) })));
  const unique = [...new Map(matches.map(match => [match.address, match])).values()];
  if (unique.length > 1_000) return undefined;
  if (!unique.length) return [];
  // An Instance is addressed by its Space registration's display name or
  // harness, or by its own id. Its actor id is the Instance itself.
  const rows = await tx.query<QueryResultRow>({ name: "message_agent_target_resolve_v5", text: `SELECT
      request.address,instance.instance_id,instance.run_id
    FROM jsonb_to_recordset($3::jsonb) AS request(address text,name text,ordinal text)
    JOIN data.channels channel ON channel.space_id=$1 AND channel.channel_id=$2
    JOIN data.instances instance ON instance.channel_id=channel.channel_id AND instance.channel_instance_id::text=request.ordinal
    JOIN data.runs run ON run.run_id=instance.run_id AND run.channel_id=channel.channel_id
    JOIN data.run_agent_registrations binding ON binding.run_id=run.run_id AND binding.space_id=channel.space_id
    JOIN data.space_agent_registrations registration ON registration.space_id=binding.space_id
      AND registration.owner_user_id=binding.owner_user_id AND registration.machine_id=binding.machine_id
      AND registration.harness=binding.harness
      AND (instance.instance_id=request.name OR lower(registration.display_name)=lower(request.name)
        OR registration.harness=lower(request.name))
    WHERE ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "channel",
        principalKindSql: "'agent'", principalIdSql: "instance.instance_id" })}
    LIMIT 2001`, values: [input.spaceId, input.channelId, JSON.stringify(unique)], maxRows: 2001 });
  // Ambiguous or missing names/ordinals remain visibly unresolved; they never
  // grant an Instance identity to a report that happens to use the same name.
  const targets = await Promise.all(unique.map(async mention => {
    const candidates = rows.filter(row => row.address === mention.address);
    const row = candidates.length === 1 && rows.length < 2001 ? candidates[0] : undefined;
    const id = await sha256Hex(JSON.stringify([input.spaceId, input.messageId, mention.address]));
    return { id,
      sourceMention: mention.address, targetName: mention.name, channelInstanceId: mention.ordinal,
      resolution: row ? "resolved" : "unavailable",
      ...(row ? { instanceId: String(row.instance_id), runId: String(row.run_id) } : {}),
    } as Target;
  }));
  return utf8ByteLength(JSON.stringify(targets)) <= 900_000 ? targets : undefined;
}

/** Caller must authorize the Channel in the same transaction. */
export async function queryMessageAgentTargets(tx: DatabaseTransaction, input: {
  spaceId: string; channelId: string; messageIds: readonly string[]; limit: number;
  position?: [string, string] | null; runId?: string;
}): Promise<{ records: SerializedAgentMessageTarget[]; next: [string, string] | null }> {
  if (input.position === null) return { records: [], next: null };
  const rows = await tx.query<QueryResultRow>({ name: "message_agent_target_query_v4", text: `SELECT
      source.message_id,source.agent_invocation_targets_json->>'entityVersion' AS entity_version,source.body_hash,source.sent_at,target.*,run.status AS run_status,
      COALESCE(source.invocation_input_version,source.entity_version) AS source_input_version,
      to_char(source.sent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM data.messages source CROSS JOIN LATERAL jsonb_to_recordset(source.agent_invocation_targets_json->'targets')
      AS target(id text,"sourceMention" text,"targetName" text,"channelInstanceId" text,resolution text,
        "instanceId" text,"runId" text)
    LEFT JOIN data.runs run ON run.run_id=target."runId" AND run.channel_id=source.channel_id
    WHERE source.space_id=$1 AND source.channel_id=$2 AND source.message_id=ANY($3::text[])
      AND source.deleted_at IS NULL AND source.recalled_at IS NULL
      AND (source.agent_invocation_targets_json->>'entityVersion')::bigint
        BETWEEN COALESCE(source.invocation_input_version,source.entity_version) AND source.entity_version
      AND source.agent_invocation_targets_json->>'bodyHash'=source.body_hash
      AND ($4::timestamptz IS NULL OR (source.sent_at,target.id)>($4::timestamptz,$5::text))
      AND ($7::text IS NULL OR target."runId"=$7)
    ORDER BY source.sent_at,target.id LIMIT $6`, values: [input.spaceId,input.channelId,input.messageIds,
      input.position?.[0] ?? null,input.position?.[1] ?? null,input.limit + 1,input.runId ?? null], maxRows: input.limit + 1 });
  const page = rows.slice(0, input.limit), last = page.at(-1);
  return { records: page.map(row => ({ id: row.id, channelId: input.channelId, sourceMessageId: row.message_id,
    sourceEntityVersion: Number(row.entity_version), sourceInputVersion: Number(row.source_input_version), sourceBodyHash: row.body_hash, sourceMention: row.sourceMention,
    targetName: row.targetName, channelInstanceId: row.channelInstanceId, resolution: row.resolution,
    ...(row.instanceId ? { instanceId: row.instanceId, runId: row.runId } : {}),
    ...(row.run_status ? { runStatus: row.run_status } : {}), createdAt: new Date(row.sent_at).toISOString(),
  })), next: rows.length > input.limit && last ? [last.cursor_at, last.id] : null };
}

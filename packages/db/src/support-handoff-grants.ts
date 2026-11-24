import type { QueryResultRow } from "pg";
import type { SupportHandoff, SupportHandoffPart, SupportHandoffStatus } from "@xmatrix/protocol";

import type { DatabaseTransaction } from "./contracts.js";
import { storedIso as iso } from "./stored-values.js";

/**
 * The support-handoff rows of data.cross_space_read_grants (grantee 'space'),
 * shared by the Run read path (cross-space-read-control.ts) and the handoff
 * routes (support-handoff-control.ts).
 */

/** Support reading a Channel is told to its people at most once an hour. */
export const ACCESS_NOTE_INTERVAL_MS = 60 * 60_000;

export const SUPPORT_COLUMNS = `grant_id,space_id,channel_id,owner_user_id,source_space_id,source_channel_id,
  status,reason,parts,read_count,requested_at,expires_at,last_read_at`;

export function supportHandoff(row: QueryResultRow, now = Date.now()): SupportHandoff {
  const expiresAt = iso(row.expires_at);
  const stored = String(row.status);
  // Expiry is a fact of time: an approved handoff past its window reads as expired.
  const status: SupportHandoffStatus = stored === "approved" && Date.parse(expiresAt) <= now ? "expired"
    : stored === "approved" || stored === "revoked" ? stored : "expired";
  return {
    id: String(row.grant_id), spaceId: String(row.space_id), channelId: String(row.channel_id),
    supportSpaceId: String(row.source_space_id), supportChannelId: String(row.source_channel_id),
    ownerUserId: String(row.owner_user_id), line: String(row.reason ?? ""),
    parts: (Array.isArray(row.parts) ? row.parts : []).map(String) as SupportHandoffPart[],
    status, readCount: Number(row.read_count), requestedAt: iso(row.requested_at), expiresAt,
    ...(row.last_read_at ? { lastReadAt: iso(row.last_read_at) } : {}),
  };
}

export interface SupportGrantUse {
  grantId: string; ownerUserId: string; channelId: string;
  /** Set when this read is the first in an hour: the Channel is told. */
  accessNote?: { channelId: string; at: string };
  logExcerpt?: string;
}

/**
 * Count one read by support on the live handoff that covers `part` and the
 * Channel (or the one named grant), and say whether the person's Channel is
 * due a note. Null when no live handoff covers it: an expired or revoked
 * handoff stops every read at once.
 */
export async function useSupportGrant(tx: DatabaseTransaction, input: {
  spaceId: string; supportSpaceId: string; part: SupportHandoffPart; at: string;
  channelId?: string | null; grantId?: string | null; supportChannelId?: string | null;
}): Promise<SupportGrantUse | null> {
  const noteBefore = new Date(Date.parse(input.at) - ACCESS_NOTE_INTERVAL_MS).toISOString();
  const rows = await tx.query<QueryResultRow>({ name: "support_handoff_use_v1", text: `UPDATE
      data.cross_space_read_grants g SET read_count=g.read_count+1,last_read_at=$4,
        access_noted_at=CASE WHEN g.access_noted_at IS NULL OR g.access_noted_at<=$5 THEN $4
          ELSE g.access_noted_at END
    WHERE g.grant_id=(SELECT c.grant_id FROM data.cross_space_read_grants c
      WHERE c.space_id=$1 AND c.grantee='space' AND c.source_space_id=$2 AND c.status='approved'
        AND c.expires_at>$4 AND $3=ANY(c.parts)
        AND ($6::text IS NULL OR c.grant_id=$6)
        AND ($8::text IS NULL OR c.source_channel_id=$8)
        AND ($7::text IS NULL OR c.channel_id=$7 OR c.channel_id=(
          SELECT t.metadata_json->>'threadRootChannelId' FROM data.channels t
            WHERE t.space_id=$1 AND t.channel_id=$7 AND t.metadata_json->>'kind'='thread'))
      ORDER BY c.expires_at DESC,c.grant_id LIMIT 1)
    RETURNING g.grant_id,g.owner_user_id,g.channel_id,g.log_excerpt,(g.access_noted_at=$4) AS note_due`,
  values: [input.spaceId, input.supportSpaceId, input.part, input.at, noteBefore, input.grantId ?? null,
    input.channelId ?? null, input.supportChannelId ?? null], maxRows: 1 });
  const row = rows[0];
  if (!row) return null;
  const channelId = String(row.channel_id);
  return { grantId: String(row.grant_id), ownerUserId: String(row.owner_user_id), channelId,
    ...(row.note_due === true ? { accessNote: { channelId, at: input.at } } : {}),
    ...(input.part === "logs" && typeof row.log_excerpt === "string" ? { logExcerpt: row.log_excerpt } : {}) };
}

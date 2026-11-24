import type { QueryResultRow } from "pg";
import type { SupportHandoff, SupportHandoffPart, SupportHandoffStatus } from "@xmatrix/protocol";

import type { DatabaseTransaction } from "./contracts.js";
import { storedIso as iso } from "./stored-values.js";

/**
 * The support-handoff rows of data.cross_space_read_grants (grantee 'space'),
 * shared by the Run read path (cross-space-read-control.ts) and the handoff
 * routes (support-handoff-control.ts).
 */

/**
 * Support reading a Channel is told to its people in one note an hour: the
 * hour's first read posts it, and every later read in that hour updates it.
 */
export const ACCESS_NOTE_INTERVAL_MS = 60 * 60_000;

/**
 * The note in the person's Channel for the hour that began at `notedAt`:
 * `reads` reads so far in that hour, the latest at `latestAt`. Its first read
 * (reads 1) posts it; every later read in the hour updates the same note.
 */
export interface SupportAccessNote { channelId: string; notedAt: string; reads: number; latestAt: string }

const minute = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** What the person's Channel says about this hour's reads. */
export function supportAccessNoteBody(note: Pick<SupportAccessNote, "notedAt" | "reads" | "latestAt">): string {
  if (note.reads <= 1) return `xMatrix support read this conversation (${minute(note.latestAt)} UTC).`;
  const latest = note.latestAt.slice(0, 10) === note.notedAt.slice(0, 10) ? note.latestAt.slice(11, 16)
    : minute(note.latestAt);
  return `xMatrix support read this conversation ${note.reads} times (latest ${latest} UTC).`;
}

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
  /** This hour's note in the person's Channel, counting this read. */
  accessNote: SupportAccessNote;
  logExcerpt?: string;
}

/**
 * The live handoff that covers `part` and the Channel (or the one named
 * grant), as a subquery on the parameters every caller passes in this order:
 * $1 space, $2 support Space, $3 part, $4 now, $5 grant, $6 Channel, $7
 * support conversation.
 */
const LIVE_SUPPORT_GRANT = `SELECT c.grant_id FROM data.cross_space_read_grants c
      WHERE c.space_id=$1 AND c.grantee='space' AND c.source_space_id=$2 AND c.status='approved'
        AND c.expires_at>$4 AND $3=ANY(c.parts)
        AND ($5::text IS NULL OR c.grant_id=$5)
        AND ($7::text IS NULL OR c.source_channel_id=$7)
        AND ($6::text IS NULL OR c.channel_id=$6 OR c.channel_id=(
          SELECT t.metadata_json->>'threadRootChannelId' FROM data.channels t
            WHERE t.space_id=$1 AND t.channel_id=$6 AND t.metadata_json->>'kind'='thread'))
      ORDER BY c.expires_at DESC,c.grant_id LIMIT 1`;

interface SupportGrantQuery {
  spaceId: string; supportSpaceId: string; part: SupportHandoffPart; at: string;
  channelId?: string | null; grantId?: string | null; supportChannelId?: string | null;
}

const liveGrantValues = (input: SupportGrantQuery) => [input.spaceId, input.supportSpaceId, input.part, input.at,
  input.grantId ?? null, input.channelId ?? null, input.supportChannelId ?? null];

/**
 * Count one read by support on the live handoff that covers `part` and the
 * Channel (or the one named grant), and in this hour's note for the person's
 * Channel: the first read of an hour starts a new note. Null when no live
 * handoff covers it: an expired or revoked handoff stops every read at once.
 */
export async function useSupportGrant(tx: DatabaseTransaction, input: SupportGrantQuery):
  Promise<SupportGrantUse | null> {
  const noteBefore = new Date(Date.parse(input.at) - ACCESS_NOTE_INTERVAL_MS).toISOString();
  const rows = await tx.query<QueryResultRow>({ name: "support_handoff_use_v2", text: `UPDATE
      data.cross_space_read_grants g SET read_count=g.read_count+1,last_read_at=$4,
        access_noted_at=CASE WHEN g.access_noted_at IS NULL OR g.access_noted_at<=$8 THEN $4
          ELSE g.access_noted_at END,
        access_note_reads=CASE WHEN g.access_noted_at IS NULL OR g.access_noted_at<=$8 THEN 1
          ELSE COALESCE(g.access_note_reads,1)+1 END
    WHERE g.grant_id=(${LIVE_SUPPORT_GRANT})
    RETURNING g.grant_id,g.owner_user_id,g.channel_id,g.log_excerpt,g.access_noted_at,g.access_note_reads`,
  values: [...liveGrantValues(input), noteBefore], maxRows: 1 });
  const row = rows[0];
  if (!row) return null;
  const channelId = String(row.channel_id);
  return { grantId: String(row.grant_id), ownerUserId: String(row.owner_user_id), channelId,
    accessNote: { channelId, notedAt: iso(row.access_noted_at), reads: Number(row.access_note_reads),
      latestAt: input.at },
    ...(input.part === "logs" && typeof row.log_excerpt === "string" ? { logExcerpt: row.log_excerpt } : {}) };
}

/**
 * The live handoff that covers `part` and the Channel, without counting a
 * read: for what a counted read shows alongside it, such as the Channel's
 * name and threads above its messages. Null when no live handoff covers it.
 */
export async function findSupportGrant(tx: DatabaseTransaction, input: SupportGrantQuery):
  Promise<{ grantId: string; ownerUserId: string } | null> {
  const rows = await tx.query<QueryResultRow>({ name: "support_handoff_find_v1", text: `SELECT
      g.grant_id,g.owner_user_id FROM data.cross_space_read_grants g WHERE g.grant_id=(${LIVE_SUPPORT_GRANT})`,
  values: liveGrantValues(input), maxRows: 1 });
  const row = rows[0];
  return row ? { grantId: String(row.grant_id), ownerUserId: String(row.owner_user_id) } : null;
}

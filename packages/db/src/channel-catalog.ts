import { checkedStoredIso } from "./stored-values.js";
import type { QueryResultRow } from "pg";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import { loadChannelAgentPresence } from "./channel-agent-presence.js";
import {
  channelVisibilityScope,
  CHANNEL_ACTIVITY_MESSAGE_KIND,
  type ChannelCatalogPageFilter,
  type ChannelCatalogPageView, utf8ByteLength } from "@xmatrix/protocol";
import { DatabaseContractError } from "./errors.js";
import { messagePreviewColumnsSql, readMessagePreview, type MessagePreview } from "./message-preview.js";
import { PostgresSpacePlacementDirectory } from "./placement.js";
import { channelPresentation, channelIdentity, type ChannelPresentationRow } from "./channel-metadata.js";

export type { ChannelCatalogPageFilter, ChannelCatalogPageView };

/**
 * A conversation's newest message as stored. Its body is inside the payload
 * bundle, which the Hub decodes into the list preview (the message codec
 * lives there).
 */
export interface ChannelHeadMessage {
  messageId: string;
  sequence: number;
  authorKind: string;
  authorId: string;
  sentAt: string;
  recalledAt: string | null;
  /** The stored preview; when present, the payload fields are not read. */
  preview: MessagePreview | null;
  payloadBundleBase64: string | null;
  legacyBody: string | null;
}

export interface ChannelCatalogPageCursor {
  sortGroup: number;
  pinRank: number;
  ownActivityAt: string;
  channelId: string;
}

export interface ChannelCatalogPageInput {
  requestId: string;
  spaceId: string;
  principal: { kind: "user" | "agent"; id: string };
  view: ChannelCatalogPageView;
  filter: ChannelCatalogPageFilter;
  query?: string;
  cursor?: ChannelCatalogPageCursor;
  limit?: number;
  /** Omit aggregate counts so the bounded first page can return immediately. */
  includeCounts?: boolean;
  /** Read only the independent aggregate used by the deferred counts request. */
  countsOnly?: boolean;
}

export interface ChannelCatalogResolveInput {
  requestId: string;
  spaceId: string;
  principal: { kind: "user" | "agent"; id: string };
  channelIds: string[];
  /** Compatibility selector for public links minted before exact IDs were embedded. */
  routeToken?: string;
  /** False returns metadata only; member/presence fields are omitted, not cleared. */
  includeParticipants?: boolean;
}

interface CatalogRow extends ChannelPresentationRow {
  activity_at: string | Date;
  created_by_fallback: string;
  history_head_sequence: string | number;
  content_revision: string | number;
  read_sequence: string | number;
  attention_count: string | number;
  last_attention_at: string | Date | null;
  last_attention_message_id: string | null;
  last_attention_sequence: string | number | null;
  last_attention_kind: string | null;
  visible_human_ids: string[] | null;
  head_message_id: string | null;
  head_sent_at: string | Date | null;
  head_author_kind: string | null;
  head_author_id: string | null;
  head_recalled_at: string | Date | null;
  head_preview_json: unknown;
  head_payload_bundle_base64: string | null;
  head_legacy_body: string | null;
  sort_group: string | number;
  pin_rank: string | number;
}

interface StatsRow extends QueryResultRow {
  principal_authorized: boolean;
  commit_sequence: string | number;
  active_count: string | number;
  unread_count: string | number;
  mentions_count: string | number;
}

interface CatalogPageEnvelope extends QueryResultRow {
  principal_authorized: boolean;
  commit_sequence: string | number;
  page_rows: CatalogRow[];
}

interface CatalogResolveRow extends CatalogRow {
  requested_channel_id: string;
  requested_route_token: string | null;
}

interface CatalogResolveEnvelope extends QueryResultRow {
  principal_authorized: boolean;
  resolved_rows: CatalogResolveRow[];
}

function bounded(value: unknown, field: string, maximum = 300): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || utf8ByteLength(result) > maximum) {
    throw new DatabaseContractError(`${field} is invalid`);
  }
  return result;
}

const UUID_MAX = (1n << 128n) - 1n;
const BASE36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

function base36Integer(value: string): bigint | null {
  let result = 0n;
  for (const character of value) {
    const digit = BASE36_DIGITS.indexOf(character);
    if (digit < 0) return null;
    result = result * 36n + BigInt(digit);
  }
  return result;
}

function uuidFromInteger(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A legacy route token is the first ten base36 digits of a UUID interpreted as
 * one 128-bit integer. Reconstruct its narrow numeric ranges so PostgreSQL can
 * use the existing channel_id primary-key index without scanning the Space.
 */
export function legacyChannelRouteUuidRanges(routeToken: string): Array<{
  lowerChannelId: string;
  upperChannelId: string;
}> {
  const normalized = routeToken.trim().toLowerCase();
  if (!/^c[a-z0-9]{8,12}$/u.test(normalized)) return [];
  const prefix = normalized.slice(1);
  const prefixValue = base36Integer(prefix);
  if (prefixValue === null) return [];
  const ranges: Array<{ lowerChannelId: string; upperChannelId: string }> = [];
  // A 128-bit integer has at most 25 base36 digits. Account for shorter UUID
  // encodings because BigInt.toString(36) has no leading zero padding.
  for (let digits = prefix.length; digits <= 25; digits += 1) {
    const suffixFactor = 36n ** BigInt(digits - prefix.length);
    const minimumForDigits = digits === 1 ? 0n : 36n ** BigInt(digits - 1);
    const lower = [prefixValue * suffixFactor, minimumForDigits]
      .reduce((maximum, candidate) => candidate > maximum ? candidate : maximum, 0n);
    const upper = [(prefixValue + 1n) * suffixFactor - 1n, UUID_MAX]
      .reduce((minimum, candidate) => candidate < minimum ? candidate : minimum, UUID_MAX);
    if (lower <= upper) {
      ranges.push({ lowerChannelId: uuidFromInteger(lower), upperChannelId: uuidFromInteger(upper) });
    }
  }
  return ranges;
}

function catalogRequest(input: { requestId: string; spaceId: string; principal: { id: string } }) {
  return { requestId: bounded(input.requestId, "requestId", 200), spaceId: bounded(input.spaceId, "spaceId"),
    principalId: bounded(input.principal.id, "principal.id") };
}

const iso = (value: string | Date) => checkedStoredIso(value,
  () => new DatabaseContractError("catalog timestamp is invalid"));

function safeCount(value: string | number | null | undefined): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new DatabaseContractError("catalog count is invalid");
  }
  return result;
}

/**
 * An open Channel's Human members are exactly the Space's members. Live Human
 * presence is overlaid at the Hub read boundary from RelayRuntime sessions, and
 * that overlay can only report the members a response names — so every catalog
 * response that serializes `memberPresence` must carry this list, or the Humans
 * the client lists silently have no presence to report.
 */
async function openChannelHumanMemberIdsBySpace(
  transaction: DatabaseTransaction,
  spaceId: string,
  rows: readonly { mode: string }[],
): Promise<Record<string, string[]>> {
  if (!rows.some((row) => row.mode === "open")) return {};
  const members = await transaction.query<QueryResultRow & { user_id: string }>({
    name: "channel_catalog_open_space_members_v2",
    text: `SELECT user_id FROM data.space_members
      WHERE space_id = $1 ORDER BY user_id LIMIT 10000`,
    values: [spaceId], maxRows: 10_000,
  });
  return members.length > 0
    ? { [spaceId]: members.map((row) => `user:${row.user_id}`) }
    : {};
}

function serialize(
  row: CatalogRow,
  memberPresence: Record<string, unknown> = {},
): Record<string, unknown> {
  const { metadata, createdBy } = channelPresentation(row);
  const historyHeadSequence = safeCount(row.history_head_sequence);
  const readSequence = safeCount(row.read_sequence);
  const attentionCount = safeCount(row.attention_count);
  // Chat-list clients (desktop/mobile flat views) rank and render from the
  // serialized Channel's updatedAt. Message appends advance activity_at but not
  // updated_at, so a busy Channel would otherwise rank by its last config write
  // and sink below idle Channels — the exact reason a continuously updating
  // Channel never reaches the top of the flat list. The legacy list-channels
  // read already folds the newest message into updatedAt
  // (channel-catalog-read.ts); the paged catalog keeps that same contract.
  const activityAt = iso(row.activity_at);
  const rowUpdatedAt = iso(row.updated_at);
  const updatedAt = Date.parse(activityAt) > Date.parse(rowUpdatedAt)
    ? activityAt
    : rowUpdatedAt;
  return {
    ...channelIdentity(row),
    messageCount: historyHeadSequence,
    historyHeadSequence,
    readSequence,
    contentAuthority: { protocolVersion: 1, contentRevision: safeCount(row.content_revision) },
    projectionCacheScopeId: channelVisibilityScope({ mode: row.mode, channelId: row.channel_id, spaceId: row.space_id }),
    ...(metadata ? { metadata } : {}),
    ...(row.mode === "closed"
      ? { visibleHumanMemberIds: (row.visible_human_ids ?? []).map((id) => `user:${id}`).sort() }
      : {}),
    memberPresence,
    memberReadSequences: {},
    ...(attentionCount > 0 ? {
      attention: {
        channelId: row.channel_id,
        unreadAttentionCount: attentionCount,
        ...(row.last_attention_at ? { lastAttentionAt: iso(row.last_attention_at) } : {}),
        ...(row.last_attention_message_id ? { lastMessageId: row.last_attention_message_id } : {}),
        ...(row.last_attention_sequence === null ? {}
          : { lastMessageSequence: safeCount(row.last_attention_sequence) }),
        ...(row.last_attention_kind ? { primaryTriggerKind: row.last_attention_kind } : {}),
        updatedAt: row.last_attention_at ? iso(row.last_attention_at) : activityAt,
      },
    } : {}),
    ...(createdBy ? { createdBy } : {}),
    createdAt: iso(row.created_at),
    updatedAt,
    ...(row.head_message_id && row.head_sent_at ? { headMessage: {
      messageId: row.head_message_id,
      sequence: historyHeadSequence,
      authorKind: row.head_author_kind ?? "user",
      authorId: row.head_author_id ?? "",
      sentAt: iso(row.head_sent_at),
      recalledAt: row.head_recalled_at ? iso(row.head_recalled_at) : null,
      preview: readMessagePreview(row.head_preview_json),
      payloadBundleBase64: row.head_payload_bundle_base64,
      legacyBody: row.head_legacy_body,
    } satisfies ChannelHeadMessage } : {}),
  };
}

const PRINCIPAL_CONTEXT_CTE = `principal_context AS MATERIALIZED (
  SELECT
    CASE WHEN input.principal_kind='user' THEN (
      SELECT member.role FROM data.space_members member
      WHERE member.space_id=input.space_id AND member.user_id=input.principal_id LIMIT 1
    ) ELSE NULL END AS role,
    CASE WHEN input.principal_kind='user' THEN EXISTS (
      SELECT 1 FROM data.space_members member
      WHERE member.space_id=input.space_id AND member.user_id=input.principal_id
    ) ELSE EXISTS (
      -- An Agent principal is a registered Run's Instance.
      SELECT 1 FROM data.instances instance
      JOIN data.run_agent_registrations binding ON binding.run_id=instance.run_id
      WHERE binding.space_id=input.space_id AND instance.instance_id=input.principal_id
    ) END AS authorized
  FROM catalog_input input
)`;

const AUTHORIZED_CHANNEL_PREDICATE = channelCapabilityPredicate({
  capability: "catalog_read", channelAlias: "c",
  principalKindSql: "input.principal_kind", principalIdSql: "input.principal_id",
});

/**
 * Every Channel of the Space the principal may read. A page or count reads all
 * of them, so it materializes them once; resolve reads only the requested
 * targets, and leaving the CTE unmaterialized lets PostgreSQL reach those rows
 * by the Channel primary key.
 */
function authorizedChannelsCte(materialized: "MATERIALIZED" | "NOT MATERIALIZED"): string {
  return `authorized_channels AS ${materialized} (
  SELECT c.channel_id,c.space_id,c.name,c.mode,
    c.metadata_json,c.version,c.created_at,c.updated_at,LOWER(c.name) AS name_key_search,
    GREATEST(c.updated_at,COALESCE(c.activity_at,c.updated_at)) AS activity_at,
    s.owner_user_id AS created_by_fallback
  FROM data.channels c
  JOIN data.spaces s ON s.space_id=c.space_id
  CROSS JOIN catalog_input input
  CROSS JOIN principal_context context
  WHERE c.space_id=input.space_id AND context.authorized AND ${AUTHORIZED_CHANNEL_PREDICATE}
)`;
}

const AUTHORIZED_CHANNELS_CTE = authorizedChannelsCte("MATERIALIZED");
const RESOLVE_AUTHORIZED_CHANNELS_CTE = authorizedChannelsCte("NOT MATERIALIZED");

/* The newest message rides every catalog row so chat lists render its preview
   from the same read that ranks the row; a list that only learns previews from
   live pushes shows "No messages yet" (or an old preview beside a newer time)
   for every conversation that stayed quiet since the page loaded. */
const HEAD_MESSAGE_COLUMNS = `message.message_id,message.timeline_sequence,message.sent_at,
  message.author_kind,message.author_id,message.recalled_at,
  ${messagePreviewColumnsSql("message")}`;
const HEAD_MESSAGE_FIELDS = `
  COALESCE((SELECT counter.content_revision FROM data.channel_content_counters counter
    WHERE counter.space_id=channel.space_id AND counter.channel_id=channel.channel_id),0)
    AS content_revision,
  head.message_id AS head_message_id,head.sent_at AS head_sent_at,
  head.author_kind AS head_author_kind,head.author_id AS head_author_id,
  head.recalled_at AS head_recalled_at,head.preview_json AS head_preview_json,
  head.payload_bundle_base64 AS head_payload_bundle_base64,
  head.legacy_body AS head_legacy_body,`;

/**
 * How far the principal has read a conversation. Activity entries after the
 * cursor need no reading (docs/design/conversation-activity.md §3.2), so a
 * reader who has read every message before them has read the conversation:
 * the effective position is just before the first unread message that is not
 * activity, or the head when there is none. Derived here; no cursor moves on
 * anyone's behalf.
 */
function effectiveReadSequenceSql(head: string): string {
  return `COALESCE((
      SELECT MIN(unread.timeline_sequence)-1 FROM data.messages unread
      WHERE unread.space_id=channel.space_id AND unread.channel_id=channel.channel_id
        AND unread.deleted_at IS NULL
        AND unread.timeline_sequence>COALESCE(cursor_row.acknowledged_sequence,0)
        AND unread.message_kind<>'${CHANNEL_ACTIVITY_MESSAGE_KIND}'
    ),GREATEST(${head},COALESCE(cursor_row.acknowledged_sequence,0)))`;
}

/** Whether anything after the principal's cursor needs reading. */
const UNREAD_MESSAGE_EXISTS_SQL = `EXISTS (SELECT 1 FROM data.messages message
      WHERE message.space_id=channel.space_id AND message.channel_id=channel.channel_id
        AND message.deleted_at IS NULL
        AND message.timeline_sequence>COALESCE(cursor_row.acknowledged_sequence,0)
        AND message.message_kind<>'${CHANNEL_ACTIVITY_MESSAGE_KIND}')`;

function catalogIndexCtes(filter: ChannelCatalogPageFilter): string {
  const hasUnread = filter === "unread" ? UNREAD_MESSAGE_EXISTS_SQL : "FALSE";
  const attentionCount = filter === "all" ? "0" : `CASE WHEN EXISTS (
      SELECT 1 FROM data.message_attention attention
      WHERE attention.space_id=channel.space_id AND attention.channel_id=channel.channel_id
        AND attention.subject_id=input.principal_kind||':'||input.principal_id
        AND (attention.awaiting_response OR attention.timeline_sequence>COALESCE(cursor_row.acknowledged_sequence,0))
    ) THEN 1 ELSE 0 END`;
  return `, pins AS MATERIALIZED (
    SELECT pin_value.channel_id,pin_value.ordinality::int AS pin_rank
    FROM data.user_space_channel_view_preferences preference
    CROSS JOIN catalog_input input
    CROSS JOIN LATERAL jsonb_array_elements_text(preference.pinned_channel_ids_json)
      WITH ORDINALITY AS pin_value(channel_id, ordinality)
    WHERE input.principal_kind='user' AND preference.space_id=input.space_id
      AND preference.user_id=input.principal_id
  ), catalog_index AS MATERIALIZED (
    SELECT channel.*,pin.pin_rank,
      ${hasUnread} AS has_unread,
      ${attentionCount} AS attention_count
    FROM authorized_channels channel
    CROSS JOIN catalog_input input
    LEFT JOIN pins pin ON pin.channel_id=channel.channel_id
    LEFT JOIN data.delivery_cursors cursor_row
      ON cursor_row.space_id=channel.space_id AND cursor_row.channel_id=channel.channel_id
        AND cursor_row.subject_id=input.principal_kind||':'||input.principal_id
  )`;
}

function filterSql(filter: ChannelCatalogPageFilter): string {
  if (filter === "unread") {
    return "(has_unread OR attention_count>0)";
  }
  return "TRUE";
}

/**
 * Every conversation the principal may read, whatever Channel it once sat
 * under and whether or not it was archived: how work is organized lives in
 * pages, so the list only answers what is active.
 */
function viewSql(view: ChannelCatalogPageView, filter: ChannelCatalogPageFilter): {
  selection: string;
  sortGroup: string;
} {
  const matching = filterSql(filter);
  // Intake (open-project-governance.md §3) is its own list; only the
  // participant who started one sees it among their conversations.
  const ownIntake = `(v.metadata_json->>'intakeOf' IS NULL OR
    v.metadata_json->>'intakeOf'=(SELECT principal_id FROM catalog_input))`;
  if (view === "intake") return {
    selection: `v.metadata_json->>'intakeOf' IS NOT NULL AND ${matching}`,
    sortGroup: "0",
  };
  if (view === "flat") return {
    selection: `${ownIntake} AND ${matching}`,
    sortGroup: "CASE WHEN v.pin_rank IS NULL THEN 1 ELSE 0 END",
  };
  return {
    selection: `((SELECT search_query FROM catalog_input)='' OR
      v.name_key_search LIKE '%'||(SELECT search_query FROM catalog_input)||'%')`,
    sortGroup: `CASE WHEN v.name_key_search=(SELECT search_query FROM catalog_input) THEN 0
      WHEN v.name_key_search LIKE (SELECT search_query FROM catalog_input)||'%' THEN 1 ELSE 2 END`,
  };
}

export class PostgresChannelCatalogRepository {
  private readonly placements: PostgresSpacePlacementDirectory;

  constructor(
    private readonly database: AuthorityDatabase,
    private readonly ownsRequestSession = false,
  ) {
    if (database.cacheMode !== "disabled") {
      throw new DatabaseContractError("Channel catalog requires uncached PostgreSQL");
    }
    this.placements = new PostgresSpacePlacementDirectory(database);
  }

  private async withRequestSession<T>(
    operation: (repository: PostgresChannelCatalogRepository) => Promise<T>,
  ): Promise<T> {
    const session = this.database.openSession();
    try {
      return await operation(new PostgresChannelCatalogRepository(session, true));
    } finally {
      await session.close();
    }
  }

  /**
   * One transaction on the Space's active placement. The fleet router reroutes
   * it once if the shard's fence refuses a placement that went stale.
   */
  private async withPlacedTransaction<T>(
    requestId: string,
    operation: string,
    spaceId: string,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const placement = await this.placements.resolve({ requestId, operation: `${operation}.placement` }, spaceId);
    if (placement.state !== "active" || placement.targetShardId !== null) {
      throw new DatabaseContractError("Space placement is unavailable");
    }
    return this.database.transaction({
      requestId, operation,
      placement: { spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch },
    }, callback);
  }

  async page(input: ChannelCatalogPageInput): Promise<Record<string, unknown>> {
    if (!this.ownsRequestSession) {
      return this.withRequestSession((repository) => repository.page(input));
    }
    const { requestId, spaceId, principalId } = catalogRequest(input);
    const query = (input.query ?? "").trim().toLocaleLowerCase().slice(0, 200);
    const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 50);
    if (!Number.isSafeInteger(limit)) throw new DatabaseContractError("limit is invalid");
    return this.withPlacedTransaction(
      requestId, "channel-catalog.page", spaceId, async (transaction) => {
      const selected = viewSql(input.view, input.filter);
      const cursor = input.cursor;
      const cursorSql = cursor ? `AND (
        sort_group>(SELECT cursor_sort_group FROM catalog_input)
        OR (sort_group=(SELECT cursor_sort_group FROM catalog_input)
          AND pin_sort>(SELECT cursor_pin_rank FROM catalog_input))
        OR (sort_group=(SELECT cursor_sort_group FROM catalog_input)
          AND pin_sort=(SELECT cursor_pin_rank FROM catalog_input)
          AND activity_at<(SELECT cursor_activity_at FROM catalog_input))
        OR (sort_group=(SELECT cursor_sort_group FROM catalog_input)
          AND pin_sort=(SELECT cursor_pin_rank FROM catalog_input)
          AND activity_at=(SELECT cursor_activity_at FROM catalog_input)
          AND channel_id>(SELECT cursor_channel_id FROM catalog_input))
      )` : "";
      const envelopes = input.countsOnly ? [] : await transaction.query<CatalogPageEnvelope>({
        name: `channel_catalog_page_${input.view}_${input.filter}_v11`,
        text: `WITH RECURSIVE catalog_input AS (
          SELECT $1::text AS space_id,$2::text AS principal_id,$3::text AS principal_kind,
            $4::text AS search_query,
            $5::integer AS cursor_sort_group,$6::integer AS cursor_pin_rank,
            $7::timestamptz AS cursor_activity_at,$8::text AS cursor_channel_id,
            $9::integer AS page_limit
        ), ${PRINCIPAL_CONTEXT_CTE}, ${AUTHORIZED_CHANNELS_CTE}
        ${catalogIndexCtes(input.filter)}, candidates AS (
          SELECT v.channel_id,v.activity_at,v.pin_rank,
            ${selected.sortGroup} AS sort_group,COALESCE(v.pin_rank,2147483647) AS pin_sort
          FROM catalog_index v
          WHERE ${selected.selection}
        ), selected_ids AS MATERIALIZED (
          SELECT * FROM candidates WHERE TRUE ${cursorSql}
          ORDER BY sort_group,pin_sort,activity_at DESC,channel_id
          LIMIT (SELECT page_limit FROM catalog_input)
        ), page_rows AS (
          SELECT channel.channel_id,channel.space_id,
            channel.name,channel.mode,channel.metadata_json,
            channel.version,channel.created_at,channel.updated_at,
            channel.name_key_search,channel.created_by_fallback,
            GREATEST(channel.activity_at,COALESCE(head.sent_at,channel.activity_at)) AS activity_at,
            COALESCE(head.timeline_sequence,0) AS history_head_sequence,${HEAD_MESSAGE_FIELDS}
            ${effectiveReadSequenceSql("COALESCE(head.timeline_sequence,0)")} AS read_sequence,
            COALESCE(attention.attention_count,0) AS attention_count,
            attention.last_attention_at,attention.last_attention_message_id,
            attention.last_attention_sequence,attention.last_attention_kind,
            CASE WHEN channel.mode='closed' THEN ARRAY(
              SELECT member.user_id FROM data.space_members member
              WHERE member.space_id=channel.space_id AND (
                EXISTS (SELECT 1 FROM data.channel_access member_access
                  WHERE member_access.space_id=channel.space_id
                    AND member_access.channel_id=channel.channel_id
                    AND member_access.subject_kind='user'
                    AND member_access.subject_id=member.user_id)
                OR member.role IN ('owner','admin')
              ) ORDER BY member.user_id
            ) ELSE NULL END AS visible_human_ids,
            selected.sort_group,selected.pin_rank,selected.pin_sort
          FROM selected_ids selected
          JOIN authorized_channels channel ON channel.channel_id=selected.channel_id
          CROSS JOIN catalog_input input
          LEFT JOIN LATERAL (
            SELECT ${HEAD_MESSAGE_COLUMNS} FROM data.messages message
            WHERE message.space_id=channel.space_id AND message.channel_id=channel.channel_id
              AND message.deleted_at IS NULL
            ORDER BY message.timeline_sequence DESC LIMIT 1
          ) head ON TRUE
          LEFT JOIN data.delivery_cursors cursor_row
            ON cursor_row.space_id=channel.space_id AND cursor_row.channel_id=channel.channel_id
              AND cursor_row.subject_id=input.principal_kind||':'||input.principal_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::bigint AS attention_count,
              MAX(item.created_at) AS last_attention_at,
              (ARRAY_AGG(item.message_id ORDER BY item.timeline_sequence DESC))[1]
                AS last_attention_message_id,
              MAX(item.timeline_sequence) AS last_attention_sequence,
              (ARRAY_AGG(item.kind ORDER BY item.timeline_sequence DESC))[1]
                AS last_attention_kind
            FROM data.message_attention item
            WHERE item.space_id=channel.space_id AND item.channel_id=channel.channel_id
              AND item.subject_id=input.principal_kind||':'||input.principal_id
              AND (item.awaiting_response OR item.timeline_sequence>COALESCE(cursor_row.acknowledged_sequence,0))
          ) attention ON TRUE
        )
        SELECT context.authorized AS principal_authorized,
          COALESCE((SELECT commit_sequence FROM data.space_control_heads
            WHERE space_id=(SELECT space_id FROM catalog_input) LIMIT 1),0) AS commit_sequence,
          COALESCE((SELECT jsonb_agg(to_jsonb(page_rows)
            ORDER BY sort_group,pin_sort,activity_at DESC,channel_id) FROM page_rows),'[]') AS page_rows
        FROM principal_context context`,
        values: [spaceId, principalId, input.principal.kind, query,
          cursor?.sortGroup ?? 0, cursor?.pinRank ?? 0, cursor?.ownActivityAt ?? null,
          cursor?.channelId ?? "", limit + 1],
        maxRows: 1,
      });
      const envelope = envelopes[0];
      if (envelope && !envelope.principal_authorized) {
        throw new DatabaseContractError("Catalog principal is unavailable in this Space");
      }
      const statsRows = input.countsOnly || input.includeCounts !== false
        ? await transaction.query<StatsRow>({
        name: "channel_catalog_counts_v8",
        text: `WITH catalog_input AS (
            SELECT $1::text AS space_id,$2::text AS principal_id,$3::text AS principal_kind
          ), ${PRINCIPAL_CONTEXT_CTE}, ${AUTHORIZED_CHANNELS_CTE}, facts AS (
            SELECT channel.*,COALESCE(cursor_row.acknowledged_sequence,0) AS read_sequence,
              ${UNREAD_MESSAGE_EXISTS_SQL} AS has_unread,
              EXISTS (SELECT 1 FROM data.message_attention attention
                WHERE attention.space_id=channel.space_id
                  AND attention.channel_id=channel.channel_id
                  AND attention.subject_id=input.principal_kind||':'||input.principal_id
                  AND (attention.awaiting_response OR attention.timeline_sequence>COALESCE(cursor_row.acknowledged_sequence,0)))
                AS has_attention
            FROM authorized_channels channel CROSS JOIN catalog_input input
            LEFT JOIN data.delivery_cursors cursor_row
              ON cursor_row.space_id=channel.space_id AND cursor_row.channel_id=channel.channel_id
                AND cursor_row.subject_id=input.principal_kind||':'||input.principal_id
          ), counts AS (SELECT
            COUNT(*) AS active_count,
            COUNT(*) FILTER (WHERE has_unread OR has_attention) AS unread_count,
            COUNT(*) FILTER (WHERE has_attention) AS mentions_count
          FROM facts) SELECT context.authorized AS principal_authorized,
            COALESCE((SELECT commit_sequence FROM data.space_control_heads
              WHERE space_id=(SELECT space_id FROM catalog_input) LIMIT 1),0) AS commit_sequence,
            counts.* FROM principal_context context CROSS JOIN counts`,
        values: [spaceId, principalId, input.principal.kind], maxRows: 1,
      }) : [];
      const stats = statsRows[0];
      if (stats && !stats.principal_authorized) {
        throw new DatabaseContractError("Catalog principal is unavailable in this Space");
      }
      if (!envelope && !stats) throw new DatabaseContractError("Catalog page is unavailable");
      const rows = envelope?.page_rows ?? [];
      const page = rows.slice(0, limit);
      const presence = await loadChannelAgentPresence(
        transaction, spaceId, page.map((row) => row.channel_id),
      );
      const last = page.at(-1);
      return {
        protocolVersion: 1,
        catalogRevision: safeCount(envelope?.commit_sequence ?? stats?.commit_sequence ?? 0),
        openChannelHumanMemberIdsBySpace:
          await openChannelHumanMemberIdsBySpace(transaction, spaceId, page),
        rows: page.map((row) => ({
          channel: serialize(row, presence.get(row.channel_id)),
          ownActivityAt: iso(row.activity_at),
        })),
        nextCursor: rows.length > limit && last ? {
          sortGroup: Number(last.sort_group), pinRank: Number(last.pin_rank ?? 2_147_483_647),
          ownActivityAt: iso(last.activity_at), channelId: last.channel_id,
        } : null,
        counts: stats ? {
          active: safeCount(stats.active_count), unread: safeCount(stats.unread_count),
          mentions: safeCount(stats.mentions_count),
        } : null,
      };
    });
  }

  async resolve(input: ChannelCatalogResolveInput): Promise<Record<string, unknown>> {
    if (!this.ownsRequestSession) {
      return this.withRequestSession((repository) => repository.resolve(input));
    }
    const { requestId, spaceId, principalId } = catalogRequest(input);
    const channelIds = [...new Set(input.channelIds.map((id) => bounded(id, "channelId")))];
    const routeToken = input.routeToken === undefined
      ? null : bounded(input.routeToken, "routeToken", 13).toLowerCase();
    const routeRanges = routeToken ? legacyChannelRouteUuidRanges(routeToken) : [];
    if (routeToken && routeRanges.length === 0) {
      throw new DatabaseContractError("routeToken is invalid");
    }
    if (channelIds.length + (routeToken ? 1 : 0) === 0 ||
        channelIds.length + (routeToken ? 1 : 0) > 200) {
      throw new DatabaseContractError("Catalog resolve must contain between 1 and 200 selectors");
    }
    return this.withPlacedTransaction(
      requestId, "channel-catalog.resolve", spaceId, async (transaction) => {
      const envelopes = await transaction.query<CatalogResolveEnvelope>({
        name: "channel_catalog_resolve_v13",
        text: `WITH catalog_input AS (
            SELECT $1::text AS space_id,$2::text AS principal_id,$3::text AS principal_kind,
              $4::text[] AS requested_channel_ids,$5::text[] AS route_range_lowers,
              $6::text[] AS route_range_uppers,$7::text AS requested_route_token
          ), ${PRINCIPAL_CONTEXT_CTE}, ${RESOLVE_AUTHORIZED_CHANNELS_CTE},
          requested_targets AS MATERIALIZED (
            SELECT requested.channel_id AS requested_channel_id,NULL::text AS requested_route_token,
              channel.channel_id
            FROM catalog_input input
            CROSS JOIN UNNEST(input.requested_channel_ids) requested(channel_id)
            JOIN authorized_channels channel ON channel.channel_id=requested.channel_id
            UNION ALL
            SELECT channel.channel_id AS requested_channel_id,input.requested_route_token,
              channel.channel_id
            FROM catalog_input input
            JOIN LATERAL (
              SELECT MIN(candidate.channel_id) AS channel_id
              FROM UNNEST(input.route_range_lowers,input.route_range_uppers)
                bounds(lower_channel_id,upper_channel_id)
              JOIN data.channels candidate
                ON candidate.space_id=input.space_id
                AND candidate.channel_id>=bounds.lower_channel_id
                AND candidate.channel_id<=bounds.upper_channel_id
                AND candidate.channel_id~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              HAVING COUNT(DISTINCT candidate.channel_id)=1
            ) route_target ON input.requested_route_token IS NOT NULL
            JOIN authorized_channels channel ON channel.channel_id=route_target.channel_id
          ), resolved AS (
            SELECT channel.channel_id,channel.space_id,
              channel.name,channel.mode,channel.metadata_json,
              channel.version,channel.created_at,channel.updated_at,
              channel.name_key_search,channel.created_by_fallback,
              GREATEST(channel.activity_at,COALESCE(head.sent_at,channel.activity_at)) AS activity_at,
              COALESCE(head.timeline_sequence,0) AS history_head_sequence,${HEAD_MESSAGE_FIELDS}
              ${effectiveReadSequenceSql("COALESCE(head.timeline_sequence,0)")} AS read_sequence,
              COALESCE(attention.attention_count,0) AS attention_count,
              attention.last_attention_at,attention.last_attention_message_id,
              attention.last_attention_sequence,attention.last_attention_kind,
              CASE WHEN $8::boolean AND channel.mode='closed' THEN ARRAY(
                SELECT member.user_id FROM data.space_members member
                WHERE member.space_id=channel.space_id AND (
                  EXISTS (SELECT 1 FROM data.channel_access member_access
                    WHERE member_access.space_id=channel.space_id
                      AND member_access.channel_id=channel.channel_id
                      AND member_access.subject_kind='user'
                      AND member_access.subject_id=member.user_id)
                  OR member.role IN ('owner','admin')
                ) ORDER BY member.user_id
              ) ELSE NULL END AS visible_human_ids,
              0 AS sort_group,2147483647 AS pin_rank,
              requested.requested_channel_id,requested.requested_route_token
            FROM requested_targets requested
            JOIN authorized_channels channel ON channel.channel_id=requested.channel_id
            CROSS JOIN catalog_input input
            LEFT JOIN LATERAL (
              SELECT ${HEAD_MESSAGE_COLUMNS} FROM data.messages message
              WHERE message.space_id=channel.space_id AND message.channel_id=channel.channel_id
                AND message.deleted_at IS NULL
              ORDER BY message.timeline_sequence DESC LIMIT 1
            ) head ON TRUE
            LEFT JOIN data.delivery_cursors cursor_row
              ON cursor_row.space_id=channel.space_id AND cursor_row.channel_id=channel.channel_id
                AND cursor_row.subject_id=input.principal_kind||':'||input.principal_id
            LEFT JOIN LATERAL (
              SELECT COUNT(*)::bigint AS attention_count,
                MAX(item.created_at) AS last_attention_at,
                (ARRAY_AGG(item.message_id ORDER BY item.timeline_sequence DESC))[1]
                  AS last_attention_message_id,
                MAX(item.timeline_sequence) AS last_attention_sequence,
                (ARRAY_AGG(item.kind ORDER BY item.timeline_sequence DESC))[1]
                  AS last_attention_kind
              FROM data.message_attention item
              WHERE item.space_id=channel.space_id AND item.channel_id=channel.channel_id
                AND item.subject_id=input.principal_kind||':'||input.principal_id
                AND (item.awaiting_response OR item.timeline_sequence>COALESCE(cursor_row.acknowledged_sequence,0))
            ) attention ON TRUE
          )
          SELECT context.authorized AS principal_authorized,
            COALESCE((SELECT jsonb_agg(to_jsonb(resolved)
              ORDER BY requested_channel_id,requested_route_token NULLS FIRST)
              FROM resolved),'[]') AS resolved_rows
          FROM principal_context context`,
        values: [spaceId, principalId, input.principal.kind,
          channelIds, routeRanges.map((range) => range.lowerChannelId),
          routeRanges.map((range) => range.upperChannelId), routeToken,
          input.includeParticipants !== false], maxRows: 1,
      });
      const envelope = envelopes[0];
      if (!envelope?.principal_authorized) {
        throw new DatabaseContractError("Catalog principal is unavailable in this Space");
      }
      const rows = envelope.resolved_rows ?? [];
      const byId = new Map<string, CatalogRow>();
      const pathsByChannelId: Record<string, string[]> = Object.create(null);
      const pathsByRouteToken: Record<string, string[]> = Object.create(null);
      for (const row of rows) {
        byId.set(row.channel_id, row);
        const paths = row.requested_route_token
          ? pathsByRouteToken : pathsByChannelId;
        const key = row.requested_route_token ?? row.requested_channel_id;
        (paths[key] ??= []).push(row.channel_id);
      }
      const presence = input.includeParticipants === false ? new Map()
        : await loadChannelAgentPresence(transaction, spaceId, [...byId.keys()]);
      return {
        protocolVersion: 1,
        channels: [...byId.values()].map((row) => {
          const channel = serialize(row, presence.get(row.channel_id));
          if (input.includeParticipants === false) {
            delete channel.memberPresence;
            delete channel.visibleHumanMemberIds;
            delete channel.memberReadSequences;
          }
          return channel;
        }),
        openChannelHumanMemberIdsBySpace: input.includeParticipants === false ? {}
          : await openChannelHumanMemberIdsBySpace(
          transaction, spaceId, [...byId.values()],
        ),
        pathsByChannelId,
        pathsByRouteToken,
      };
    });
  }
}

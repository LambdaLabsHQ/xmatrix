import type { QueryResultRow } from "pg";
import type { PageConversation } from "@xmatrix/protocol";
import { isLiveAgentStatus } from "@xmatrix/protocol";
import type { AuthorityDatabase } from "./contracts.js";
import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import type { ChannelHeadMessage } from "./channel-catalog.js";
import { loadChannelAgentPresence } from "./channel-agent-presence.js";
import { messagePreviewColumnsSql, readMessagePreview } from "./message-preview.js";
import { inActiveSpace, pageActor, PageControlError, type PagePrincipal } from "./page-control.js";

/** Conversations described in one read: the most a page's margin and awareness can show. */
export const MAX_PAGE_CONVERSATIONS = 100;

export type PageConversationRecord = Omit<PageConversation, "lastMessage"> & {
  head: ChannelHeadMessage | null;
};

interface ConversationRow extends QueryResultRow {
  channel_id: string;
  name: string | null;
  activity_at: string | Date;
  read_sequence: string | number | null;
  message_id: string | null;
  timeline_sequence: string | number | null;
  author_kind: string | null;
  author_id: string | null;
  sent_at: string | Date | null;
  recalled_at: string | Date | null;
  preview_json: unknown;
  payload_bundle_base64: string | null;
  legacy_body: string | null;
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * The conversations linked to a page as one reader sees them beside it
 * (docs/design/pages-live-document.md §4.4): each one's name, newest message,
 * the reader's read position and the Agents live in it. Only conversations
 * the reader may read are described; the others are left out, as links
 * grant nothing.
 */
export async function readPageConversations(database: AuthorityDatabase, input: {
  requestId: string; spaceId: string; principal: PagePrincipal; conversationIds: readonly string[];
}): Promise<PageConversationRecord[]> {
  const conversationIds = [...new Set(input.conversationIds)];
  if (conversationIds.length > MAX_PAGE_CONVERSATIONS ||
      conversationIds.some((id) => typeof id !== "string" || !id || id.length > 300)) {
    throw new PageControlError("invalid_request", 400, "conversationIds is invalid");
  }
  if (conversationIds.length === 0) return [];
  return inActiveSpace(database, { requestId: input.requestId, operation: "page.conversations",
    spaceId: input.spaceId }, PageControlError, async (tx) => {
    const actor = await pageActor(tx, input.spaceId, input.principal, false);
    const rows = await tx.query<ConversationRow>({
      name: "page_conversations_v1",
      text: `SELECT c.channel_id, c.name, c.activity_at, cursor_row.acknowledged_sequence AS read_sequence,
          head.message_id, head.timeline_sequence, head.author_kind, head.author_id, head.sent_at,
          head.recalled_at, head.preview_json, head.payload_bundle_base64, head.legacy_body
        FROM data.channels c
        LEFT JOIN data.delivery_cursors cursor_row ON cursor_row.space_id=c.space_id
          AND cursor_row.channel_id=c.channel_id AND cursor_row.subject_id='user:'||$3
        LEFT JOIN LATERAL (
          SELECT m.message_id, m.timeline_sequence, m.author_kind, m.author_id, m.sent_at, m.recalled_at,
            ${messagePreviewColumnsSql("m")}
          FROM data.messages m
          WHERE m.space_id=c.space_id AND m.channel_id=c.channel_id AND m.deleted_at IS NULL
          ORDER BY m.timeline_sequence DESC LIMIT 1
        ) head ON TRUE
        WHERE c.space_id=$1 AND c.channel_id = ANY($2::text[])
          AND ${channelCapabilityPredicate({ capability: "message_content_read", channelAlias: "c",
            principalKindSql: "'user'", principalIdSql: "$3" })}`,
      values: [input.spaceId, conversationIds, actor.userId],
      maxRows: MAX_PAGE_CONVERSATIONS,
    });
    const presence = await loadChannelAgentPresence(tx, input.spaceId, rows.map((row) => row.channel_id));
    return rows.map((row): PageConversationRecord => {
      const agents = Object.values(presence.get(row.channel_id) ?? {}).flatMap((member) => {
        // A sleeping Instance is not working on anything; only live ones are shown.
        if (member.kind !== "agent") return [];
        return (member.instances ?? []).flatMap((instance) => {
          if (!isLiveAgentStatus(instance.status)) return [];
          return [{
            instanceId: instance.id, name: instance.label || member.label || "Agent",
            status: instance.status,
            ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
          }];
        });
      });
      return {
        conversationId: row.channel_id,
        name: row.name,
        activityAt: iso(row.sent_at && Date.parse(iso(row.sent_at)) > Date.parse(iso(row.activity_at))
          ? row.sent_at : row.activity_at),
        headSequence: Number(row.timeline_sequence ?? 0),
        readSequence: Number(row.read_sequence ?? 0),
        agents,
        head: row.message_id ? {
          messageId: row.message_id,
          sequence: Number(row.timeline_sequence),
          authorKind: row.author_kind ?? "user",
          authorId: row.author_id ?? "",
          sentAt: iso(row.sent_at!),
          recalledAt: row.recalled_at === null ? null : iso(row.recalled_at),
          preview: readMessagePreview(row.preview_json),
          payloadBundleBase64: row.payload_bundle_base64,
          legacyBody: row.legacy_body,
        } : null,
      };
    });
  });
}

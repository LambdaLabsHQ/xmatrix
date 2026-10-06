import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/** Older thread copies omitted the version required by media loaders. Recover
 * it from the exact attachment edge, never from a guessed initial version. */
export async function hydrateHistoryAttachmentVersions(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelId: string,
  page: Array<{ message_id: string; recalled_at: unknown; attachments_json: unknown[] }>,
): Promise<void> {
  const missing = page.flatMap((message) => message.recalled_at ? [] :
    message.attachments_json.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const attachment = value as Record<string, unknown>;
      return attachment.version === undefined && typeof attachment.id === "string"
        ? [{ messageId: message.message_id, attachment }] : [];
    }));
  if (missing.length === 0) return;
  const rows = await transaction.query<QueryResultRow & {
    message_id: string; attachment_id: string; version: string | number; content_hash: string;
  }>({
    name: "message_history_attachment_versions_v1",
    text: `SELECT a.message_id,a.attachment_id,a.version,a.content_hash
      FROM data.message_attachment_refs a
      JOIN jsonb_to_recordset($3::jsonb) AS requested("messageId" text,"attachmentId" text)
        ON requested."messageId"=a.message_id AND requested."attachmentId"=a.attachment_id
      WHERE a.space_id=$1 AND a.channel_id=$2`,
    values: [spaceId, channelId, JSON.stringify(missing.map(({ messageId, attachment }) => ({
      messageId, attachmentId: attachment.id,
    })))],
    maxRows: missing.length,
  });
  const versions = new Map(rows.map((row) => [
    JSON.stringify([row.message_id, row.attachment_id]), row,
  ]));
  for (const { messageId, attachment } of missing) {
    const row = versions.get(JSON.stringify([messageId, attachment.id]));
    const version = Number(row?.version);
    if (row && row.content_hash === attachment.contentHash &&
        Number.isSafeInteger(version) && version > 0) attachment.version = version;
  }
}

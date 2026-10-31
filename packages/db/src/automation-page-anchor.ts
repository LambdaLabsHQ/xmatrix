import type { QueryResultRow } from "pg";
import { sha256Hex } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { commitAutomationChange } from "./automation-commit.js";
import { RESOURCE_PAGE_SIZE, resourcePages } from "./resource-pages.js";

/**
 * A removed page takes its Automations with it: they belong to the page and
 * have nowhere else to be anchored. Returns the conversations to tell.
 */
export async function removePageAutomations(tx: DatabaseTransaction, input: {
  spaceId: string; pageId: string; at: string;
}): Promise<string[]> {
  const read = (after: string | null) => tx.query<QueryResultRow>({ name: "page_automations_remove_v2", text: `SELECT
      a.automation_id,a.channel_id,a.version
    FROM data.automations a JOIN data.channels c ON c.channel_id=a.channel_id
    WHERE a.page_id=$1 AND c.space_id=$2 AND ($3::text IS NULL OR a.automation_id>$3)
    ORDER BY a.automation_id LIMIT $4 FOR UPDATE OF a`,
  values: [input.pageId, input.spaceId, after, RESOURCE_PAGE_SIZE], maxRows: RESOURCE_PAGE_SIZE });
  const channels = new Set<string>();
  for await (const rows of resourcePages(read, (row) => String(row.automation_id))) {
    const ids = rows.map((row) => String(row.automation_id));
    await tx.query({ name: "page_automations_remove_occurrences_v1", text: `UPDATE
      data.automation_occurrences SET status='cancelled',lease_owner=NULL,lease_until=NULL,
      error_code='page_removed',error_message='Its page was removed before dispatch',
      updated_at=$1,finished_at=$1 WHERE automation_id=ANY($2::text[]) AND status IN ('pending','leased')`,
    values: [input.at, ids], maxRows: 0 });
    await tx.query({ name: "page_automations_remove_rows_v1",
      text: "DELETE FROM data.automations WHERE automation_id=ANY($1::text[])", values: [ids], maxRows: 0 });
    for (const row of rows) {
      const kind = "automation_remove";
      const commandId = `page-removed:${input.pageId}:${String(row.automation_id)}`.slice(0, 200);
      await commitAutomationChange(tx, input.spaceId, commandId, kind, await sha256Hex(commandId), {
        commandId, kind, entityId: String(row.automation_id), channelId: String(row.channel_id),
        entityVersion: Number(row.version) + 1, reused: false, projectionMutations: [], recipientChanges: [],
      }, input.at);
    }
    for (const row of rows) channels.add(String(row.channel_id));
  }
  return [...channels];
}

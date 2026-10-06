import type { QueryResultRow } from "pg";
import { automationReferences, sha256Hex } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";
import { commitAutomationChange } from "./automation-commit.js";
import { storedIso } from "./stored-values.js";

const MAX_PAGE_AUTOMATIONS = 200;

/**
 * A page's text is where its Automations are anchored
 * (docs/design/pages-live-document.md §6.1): an Automation whose reference
 * left the head revision is paused as detached, and one whose reference came
 * back resumes. Runs in the transaction that moves the page's head, so the
 * text and what runs never disagree. Returns the conversations whose
 * coordinators must hear of the change.
 */
export async function reconcilePageAutomations(tx: DatabaseTransaction, input: {
  spaceId: string; pageId: string; body: string; at: string; revision: number;
}): Promise<string[]> {
  const referenced = automationReferences(input.body);
  const rows = await tx.query<QueryResultRow>({ name: "page_automations_reconcile_v2", text: `SELECT
      a.automation_id,a.channel_id,a.enabled,a.detached_at,a.version,
      a.created_at,a.next_run_at,a.last_run_at
    FROM data.automations a JOIN data.channels c ON c.channel_id=a.channel_id
    WHERE a.page_id=$1 AND c.space_id=$2 ORDER BY a.automation_id FOR UPDATE OF a`,
  values: [input.pageId, input.spaceId], maxRows: MAX_PAGE_AUTOMATIONS });
  const changed: string[] = [];
  for (const row of rows) {
    const automationId = String(row.automation_id);
    const present = referenced.has(automationId);
    const detach = !present && row.enabled === true;
    const attach = present && row.detached_at !== null;
    if (!detach && !attach) continue;
    const version = Number(row.version) + 1;
    const nextRunAt = attach ? nextRunWhenEnabled(row, input.at) : storedIso(row.next_run_at);
    if (detach) {
      await tx.query({ name: "page_automation_detach_occurrences_v1", text: `UPDATE
        data.automation_occurrences SET status='cancelled',lease_owner=NULL,lease_until=NULL,
        error_code='automation_detached',error_message='Its reference left the page before dispatch',
        updated_at=$1,finished_at=$1 WHERE automation_id=$2 AND status IN ('pending','leased')`,
      values: [input.at, automationId], maxRows: 0 });
    }
    await tx.query({ name: "page_automation_anchor_v2", text: `UPDATE data.automations SET
        enabled=$1,detached_at=$2,next_run_at=$3,version=$4,updated_at=$5 WHERE automation_id=$6`,
    values: [attach, detach ? input.at : null, nextRunAt, version, input.at, automationId], maxRows: 0 });
    const kind = "automation_put";
    const commandId = `page-anchor:${input.pageId}:${input.revision}:${automationId}`.slice(0, 200);
    await commitAutomationChange(tx, input.spaceId, commandId, kind, await sha256Hex(commandId), {
      commandId, kind, entityId: automationId, channelId: String(row.channel_id), entityVersion: version,
      reused: false, projectionMutations: [], recipientChanges: [],
    }, input.at);
    changed.push(String(row.channel_id));
  }
  return [...new Set(changed)];
}

/**
 * The first due starts when the page reference enables the Automation. Create
 * stamps that delay while the row is still detached, and a slow page edit can
 * pass the stamp before anything may run. Leaving it there makes the due claim
 * bump the version, so a pause that still holds the create version conflicts.
 * An Automation that has already run keeps the schedule it has.
 */
function nextRunWhenEnabled(row: QueryResultRow, at: string): string {
  const next = storedIso(row.next_run_at);
  if (row.last_run_at != null) return next;
  const atMs = Date.parse(at);
  const nextMs = Date.parse(next);
  if (!(nextMs <= atMs)) return next;
  const delayMs = Math.max(0, nextMs - Date.parse(storedIso(row.created_at)));
  return new Date(atMs + delayMs).toISOString();
}

/**
 * A removed page takes its Automations with it: they belong to the page and
 * have nowhere else to be anchored. Returns the conversations to tell.
 */
export async function removePageAutomations(tx: DatabaseTransaction, input: {
  spaceId: string; pageId: string; at: string;
}): Promise<string[]> {
  const rows = await tx.query<QueryResultRow>({ name: "page_automations_remove_v1", text: `SELECT
      a.automation_id,a.channel_id,a.version
    FROM data.automations a JOIN data.channels c ON c.channel_id=a.channel_id
    WHERE a.page_id=$1 AND c.space_id=$2 ORDER BY a.automation_id FOR UPDATE OF a`,
  values: [input.pageId, input.spaceId], maxRows: MAX_PAGE_AUTOMATIONS });
  if (!rows.length) return [];
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
  return [...new Set(rows.map((row) => String(row.channel_id)))];
}

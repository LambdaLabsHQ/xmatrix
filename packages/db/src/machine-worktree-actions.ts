import { parseWorktreeActionRequest, parseWorktreeActionResult, WORKTREE_ACTION_SETTLE_MS,
  type WorktreeActionStatus } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { statusColumns } from "./machine-harness-actions.js";

function worktreeActionStatus(row: QueryResultRow): WorktreeActionStatus {
  const issued = parseWorktreeActionRequest(row.payload_json);
  const requestedAt = row.created_at ? new Date(row.created_at as Date | string).toISOString() : undefined;
  const completedAt = row.completed_at ? new Date(row.completed_at as Date | string).toISOString() : undefined;
  const base = { controlId: String(row.command_id), action: issued.action, ...(requestedAt ? { requestedAt } : {}) };
  if (row.status === "completed") {
    const result = parseWorktreeActionResult((row.result_json as Record<string, unknown>)?.result, issued);
    return { ...base, status: result.status, result, ...(completedAt ? { completedAt } : {}),
      ...(result.status === "failed" ? { error: result.error ?? "The daemon could not run the action" } : {}) };
  }
  if (row.status === "failed") return { ...base, status: "failed", error: "The daemon could not run the action",
    ...(completedAt ? { completedAt } : {}) };
  if (row.status === "pending" && row.expired === true) return { ...base, status: "expired",
    error: "The machine did not pick up the action within 10 minutes, so it was not run" };
  if (row.abandoned === true) return { ...base, status: "expired",
    error: "The machine stopped responding before it reported a result; list the worktrees again to see what changed" };
  return { ...base, status: row.status === "leased" ? "running" : "queued" };
}

/** The owner's view of one worktree action; anything else reads as missing. */
export async function readWorktreeActionStatus(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; controlId: string;
}): Promise<WorktreeActionStatus | { controlId: string; status: "missing" }> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.worktree-action-status" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_worktree_action_status_v1", text: `SELECT
        command_id,${statusColumns(3)}
        FROM data.machine_daemon_commands WHERE command_id=$1 AND owner_user_id=$2
          AND command_type='worktree_action' LIMIT 1`,
      values: [input.controlId, input.ownerUserId, WORKTREE_ACTION_SETTLE_MS], maxRows: 1 });
      const row = rows[0];
      return row ? worktreeActionStatus(row) : { controlId: input.controlId, status: "missing" };
    });
}

/**
 * The owner's latest completed listing of one Machine in the last day, so the
 * page shows it at once instead of waiting for the daemon to size every tree
 * again. Read-only: what the daemon last answered, never a new fact.
 */
export async function readLatestWorktreeListing(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string;
}): Promise<WorktreeActionStatus | undefined> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.worktree-action-latest" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_worktree_action_latest_v1", text: `SELECT
        command_id,${statusColumns(3)}
        FROM data.machine_daemon_commands WHERE owner_user_id=$1 AND machine_id=$2
          AND command_type='worktree_action' AND payload_json->>'action'='list' AND status='completed'
          AND created_at>clock_timestamp()-interval '1 day'
        ORDER BY created_at DESC,command_id DESC LIMIT 1`,
      values: [input.ownerUserId, input.machineId, WORKTREE_ACTION_SETTLE_MS], maxRows: 1 });
      return rows[0] ? worktreeActionStatus(rows[0]) : undefined;
    });
}

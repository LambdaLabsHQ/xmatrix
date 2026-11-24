import { LOG_EXCERPT_SETTLE_MS, parseLogExcerptResult, type LogExcerptStatus } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { actionTimes, statusColumns, unsettledActionStatus } from "./machine-harness-actions.js";

/**
 * The owner's view of one daemon log excerpt (docs/cross-space-read-grants.md#support-handoffs);
 * anything else, including another person's request, reads as missing.
 */
export async function readLogExcerptStatus(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; controlId: string;
}): Promise<LogExcerptStatus | { controlId: string; status: "missing" }> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.log-excerpt-status" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_log_excerpt_status_v1", text: `SELECT
        command_id,${statusColumns(3)}
        FROM data.machine_daemon_commands WHERE command_id=$1 AND owner_user_id=$2
          AND command_type='log_excerpt' LIMIT 1`,
      values: [input.controlId, input.ownerUserId, LOG_EXCERPT_SETTLE_MS], maxRows: 1 });
      const row = rows[0];
      if (!row) return { controlId: input.controlId, status: "missing" };
      const base = { controlId: input.controlId, ...actionTimes(row) };
      if (row.status !== "completed") {
        const { requestedAt } = base;
        return { controlId: input.controlId, ...(requestedAt ? { requestedAt } : {}),
          ...unsettledActionStatus(row, "ask for the logs again") };
      }
      const result = parseLogExcerptResult((row.result_json as Record<string, unknown>)?.result);
      return { ...base, status: result.status,
        ...(result.excerpt === undefined ? {} : { excerpt: result.excerpt }),
        ...(result.error === undefined ? {} : { error: result.error }) };
    });
}

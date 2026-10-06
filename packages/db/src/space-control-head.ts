import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/**
 * Advances a Space's control head by one and returns the new commit sequence,
 * or `undefined` when the head row is missing. Every authority path that
 * commits to a Space runs the same statement, so it lives here once; each
 * caller keeps its own statement name for telemetry and its own error type.
 */
export async function advanceSpaceControlHead(
  transaction: DatabaseTransaction,
  input: { name: string; spaceId: string; at: string },
): Promise<number | undefined> {
  const heads = await transaction.query<QueryResultRow & { commit_sequence: string | number }>({
    name: input.name,
    text: `UPDATE data.space_control_heads SET commit_sequence = commit_sequence + 1,
      updated_at = $2 WHERE space_id = $1 RETURNING commit_sequence`,
    values: [input.spaceId, input.at], maxRows: 1,
  });
  return heads[0] ? Number(heads[0].commit_sequence) : undefined;
}

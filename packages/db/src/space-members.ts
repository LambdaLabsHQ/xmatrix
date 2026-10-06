import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";

/** The user's role in the Space, or null when they are not a member. */
export async function spaceMemberRole(transaction: DatabaseTransaction, name: string, spaceId: string,
  userId: string): Promise<string | null> {
  const rows = await transaction.query<QueryResultRow>({ name, text: `SELECT role
    FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1`, values: [spaceId, userId], maxRows: 1 });
  return rows[0] ? String(rows[0].role) : null;
}

/**
 * Appends one `data.space_members` row. Every Space-control path and the
 * deletion restore path write the same nine columns, so they share this one
 * statement and keep only their own telemetry name and values. The written row
 * is identical to the statement each caller used to inline.
 */
export async function insertSpaceMember(
  transaction: DatabaseTransaction,
  input: {
    name: string;
    spaceId: string;
    userId: string;
    role: string;
    version: number;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    createdAt: string;
    updatedAt: string;
  },
): Promise<void> {
  await transaction.query({
    name: input.name,
    text: `INSERT INTO data.space_members
      (space_id,user_id,role,version,email,display_name,avatar_url,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    values: [input.spaceId, input.userId, input.role, input.version, input.email,
      input.displayName, input.avatarUrl, input.createdAt, input.updatedAt],
    maxRows: 0,
  });
}

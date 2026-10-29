import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";

/** Current Space authority, shared by credential stores; never inferred from a grant. */
export async function requireCredentialAdmin(tx: DatabaseTransaction, spaceId: string, userId: string): Promise<void> {
  const role = await tx.query<QueryResultRow>({ name: "app_credential_role_v2", text: `SELECT role
    FROM data.space_members WHERE space_id=$1 AND user_id=$2
      AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=$1)
    LIMIT 1 FOR SHARE`, values: [spaceId, userId], maxRows: 1 });
  if (role[0]?.role !== "owner" && role[0]?.role !== "admin") {
    throw new AppControlError("space_not_found", 404, "Space not found");
  }
}

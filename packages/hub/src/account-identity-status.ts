import { ControlError } from "@xmatrix/db";
import { authAuthority, authPostgresTransaction } from "./auth-authority";
import type { Env } from "./types";

/** PostgreSQL owns deletion; no token/cache can resurrect a committed identity. */
export async function accountIdentityRevoked(env: Env, userId: string): Promise<boolean> {
  if (authAuthority(env) !== "postgres") return false; // This deployment cannot accept deletion requests.
  try {
    return await authPostgresTransaction(env, "auth.account-revocation", async tx =>
      (await tx.query({ name: "auth_account_revocation_v1", text: `SELECT 1 FROM control.account_deletion_requests
        WHERE user_id=$1 AND state IN ('committed','completed')`, values: [userId], maxRows: 1 })).length > 0);
  } catch {
    throw new ControlError("auth_verification_unavailable", 503, "Sign-in could not be checked right now. Try again.", true);
  }
}

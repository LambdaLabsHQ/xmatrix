import { accountIdentityRevoked as revokedOnDirectory, ControlError } from "@xmatrix/db";
import { authAuthority, authPostgresTransaction } from "./auth-authority";
import type { Env } from "./types";

/** PostgreSQL owns deletion; no token/cache can resurrect a committed identity. */
export async function accountIdentityRevoked(env: Env, userId: string): Promise<boolean> {
  if (authAuthority(env) !== "postgres") return false; // This deployment cannot accept deletion requests.
  try {
    // Every authenticated request asks this, so it is one lock-free read, not BEGIN, read and COMMIT.
    return await authPostgresTransaction(env, "auth.account-revocation", (tx) => revokedOnDirectory(tx, userId),
      { statement: "single_read" });
  } catch {
    throw new ControlError("auth_verification_unavailable", 503, "Sign-in could not be checked right now. Try again.", true);
  }
}

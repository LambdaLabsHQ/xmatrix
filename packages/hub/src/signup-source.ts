import type { SignupSource } from "@xmatrix/protocol";
import { authAuthority, authPostgresTransaction } from "./auth-authority";
import type { Env } from "./types";

/**
 * How long after its creation an account still takes its signup source. The
 * new account's first page sends it right away; a later visit, from wherever
 * it came, says nothing about how the person found xMatrix.
 */
export const SIGNUP_SOURCE_WINDOW_HOURS = 24;

/**
 * Records where a new account came from (migration 0277), once: only while
 * the account is younger than the window and has no source yet. True when
 * this call recorded it; false when the account is older, already has one,
 * or does not exist.
 */
export async function recordSignupSource(env: Env, userId: string, source: SignupSource): Promise<boolean> {
  if (authAuthority(env) !== "postgres") throw new Error("Signup source needs the PostgreSQL authority");
  return authPostgresTransaction(env, "auth.signup_source.record", async (transaction) => {
    const rows = await transaction.query<{ id: string }>({
      name: "auth_signup_source_record_v1",
      text: `UPDATE control.auth_users SET signup_source_host = $2, signup_source_ref = $3
        WHERE id = $1 AND signup_source_host IS NULL
          AND created_at > now() - make_interval(hours => $4)
        RETURNING id`,
      values: [userId, source.host, source.ref, SIGNUP_SOURCE_WINDOW_HOURS], maxRows: 1,
    });
    return rows.length === 1;
  });
}

import {
  DIAGNOSTICS_CHOICES,
  diagnosticsRegimeForCountry,
  type DiagnosticsChoice,
  type DiagnosticsConsentState,
  type DiagnosticsRegime,
} from "@xmatrix/protocol";
import { authAuthority, authPostgresTransaction } from "./auth-authority";
import type { Env } from "./types";

/**
 * An account's diagnostics consent facts (migration 0271): the regime of the
 * country it signed up from, recorded once, and its explicit choice. Clients
 * decide with `diagnosticsDecision` (packages/protocol) from these and the
 * regime of the request they make, which only the edge knows.
 */

/**
 * The regime of the country Cloudflare's edge placed this request in. Only the
 * edge's own `cf.country` counts: a header could be set by any caller.
 */
export function requestDiagnosticsRegime(request: Request): DiagnosticsRegime {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  return diagnosticsRegimeForCountry(typeof cf?.country === "string" ? cf.country : null);
}

export function parseDiagnosticsChoice(value: unknown): DiagnosticsChoice | null {
  return DIAGNOSTICS_CHOICES.includes(value as DiagnosticsChoice) ? value as DiagnosticsChoice : null;
}

function requirePostgres(env: Env): void {
  if (authAuthority(env) !== "postgres") throw new Error("Diagnostics consent needs the PostgreSQL authority");
}

/**
 * Records the signup regime of a new account. Never overwrites one already
 * recorded. Swallows failures: this runs inside account creation, where a throw
 * fails the sign-up, and an account without a regime reads as consent-required
 * until its first beta read records one.
 */
export async function recordSignupDiagnosticsRegime(env: Env, userId: string, regime: DiagnosticsRegime) {
  try {
    requirePostgres(env);
    await authPostgresTransaction(env, "auth.diagnostics.record_signup_regime", async (transaction) => {
      await transaction.query({
        name: "auth_diagnostics_record_regime_v1",
        text: `UPDATE control.auth_users SET diagnostics_regime = $2
          WHERE id = $1 AND diagnostics_regime IS NULL`,
        values: [userId, regime], maxRows: 0,
      });
    });
  } catch {
    // Intentionally silent; see above.
  }
}

/**
 * This account's consent facts and the regime of the request reading them. A
 * beta read records the request regime as the account's regime when the account
 * has none yet (one created before the column); a stable read records nothing
 * and answers consent-required for a missing one.
 */
export async function readDiagnosticsConsent(env: Env, userId: string, requestRegime: DiagnosticsRegime,
  options: { recordMissingRegime: boolean }): Promise<DiagnosticsConsentState | null> {
  requirePostgres(env);
  return authPostgresTransaction(env, "auth.diagnostics.read", async (transaction) => {
    if (options.recordMissingRegime) {
      await transaction.query({
        name: "auth_diagnostics_record_regime_v1",
        text: `UPDATE control.auth_users SET diagnostics_regime = $2
          WHERE id = $1 AND diagnostics_regime IS NULL`,
        values: [userId, requestRegime], maxRows: 0,
      });
    }
    const rows = await transaction.query<{ regime: string | null; choice: string | null }>({
      name: "auth_diagnostics_read_v1",
      text: `SELECT diagnostics_regime AS regime, diagnostics_choice AS choice
        FROM control.auth_users WHERE id = $1 LIMIT 1`,
      values: [userId], maxRows: 1,
    });
    const row = rows[0];
    if (!row) return null;
    return {
      accountRegime: row.regime === "default-ok" ? "default-ok" : "consent-required",
      requestRegime,
      choice: parseDiagnosticsChoice(row.choice),
    };
  });
}

/** Records an explicit choice and when it was made. False when the account is gone. */
export async function recordDiagnosticsChoice(env: Env, userId: string, choice: DiagnosticsChoice): Promise<boolean> {
  requirePostgres(env);
  return authPostgresTransaction(env, "auth.diagnostics.choose", async (transaction) => {
    const rows = await transaction.query<{ id: string }>({
      name: "auth_diagnostics_choose_v1",
      text: `UPDATE control.auth_users SET diagnostics_choice = $2, diagnostics_choice_at = now()
        WHERE id = $1 RETURNING id`,
      values: [userId, choice], maxRows: 1,
    });
    return rows.length > 0;
  });
}

import { decodeJwt } from "jose";
import { authAuthority, authPostgresTransaction } from "./auth-authority";
import type { Env } from "./types";

/**
 * A person's own signed-in sessions, to see where they are signed in and end
 * any of them. Sessions the Hub issues itself (a terminal's, a desktop or
 * phone app's) carry an `xMatrix …` label in place of a browser's user agent;
 * older ones carry none.
 */
export interface SignedInSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

/** How many sessions the list shows, most recently used first. */
const LISTED_SESSIONS = 50;

/** The labels the Hub writes on sessions it issues itself (`session-labels`). */
export const SESSION_LABELS = {
  cli: "xMatrix CLI",
  device: "xMatrix device sign-in",
  app: "xMatrix app",
} as const;

/** A Hub-issued session's label: what holds it, then what that client says it is. */
export function sessionLabel(holder: string, userAgent: string | undefined | null): string {
  // eslint-disable-next-line no-control-regex
  const client = (userAgent ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 160);
  return client ? `${holder} · ${client}` : holder;
}

/** Which session an access token was minted from, if it was minted from one. */
export function accessTokenSessionId(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const sessionId = decodeJwt(token).auth_session_id;
    return typeof sessionId === "string" && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

function requirePostgres(env: Env): void {
  if (authAuthority(env) !== "postgres") throw new Error("Session management needs the PostgreSQL authority");
}

export async function listSignedInSessions(env: Env, userId: string, currentSessionId: string | null):
  Promise<{ sessions: SignedInSession[]; total: number }> {
  requirePostgres(env);
  return authPostgresTransaction(env, "auth.sessions.list", async (transaction) => {
    const rows = await transaction.query<{
      id: string; created_at: Date; updated_at: Date; expires_at: Date; user_agent: string | null; total: number;
    }>({
      name: "auth_sessions_list_v1",
      text: `SELECT id, created_at, updated_at, expires_at, user_agent, count(*) OVER ()::int AS total
        FROM control.auth_sessions WHERE user_id = $1 AND expires_at > now()
        ORDER BY (id = $2) DESC, updated_at DESC, created_at DESC LIMIT $3`,
      values: [userId, currentSessionId ?? "", LISTED_SESSIONS], maxRows: LISTED_SESSIONS,
    });
    return {
      total: rows[0]?.total ?? 0,
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
        userAgent: row.user_agent,
        current: row.id === currentSessionId,
      })),
    };
  });
}

/** Ends one of the person's own sessions; false when it is not theirs or already gone. */
export async function revokeSignedInSession(env: Env, userId: string, sessionId: string): Promise<boolean> {
  requirePostgres(env);
  return authPostgresTransaction(env, "auth.sessions.revoke", async (transaction) => {
    const rows = await transaction.query<{ id: string }>({
      name: "auth_sessions_revoke_one_v1",
      text: "DELETE FROM control.auth_sessions WHERE id = $1 AND user_id = $2 RETURNING id",
      values: [sessionId, userId], maxRows: 1,
    });
    return rows.length > 0;
  });
}

/**
 * Ends every other session of the person. `browsers` keeps the ones terminals
 * and daemons hold (and older unlabelled ones, which the Hub issued to them);
 * `everything` signs those out too.
 */
export async function revokeOtherSignedInSessions(env: Env, userId: string, currentSessionId: string | null,
  scope: "browsers" | "everything"): Promise<number> {
  requirePostgres(env);
  return authPostgresTransaction(env, "auth.sessions.revoke_others", async (transaction) => {
    const rows = await transaction.query<{ revoked: number }>({
      name: "auth_sessions_revoke_others_v1",
      text: `WITH revoked AS (
          DELETE FROM control.auth_sessions WHERE user_id = $1 AND id <> $2
            AND ($3 = 'everything' OR user_agent LIKE 'Mozilla/%' OR user_agent LIKE $4)
          RETURNING 1)
        SELECT count(*)::int AS revoked FROM revoked`,
      values: [userId, currentSessionId ?? "", scope, `${SESSION_LABELS.app}%`], maxRows: 1,
    });
    return rows[0]?.revoked ?? 0;
  });
}

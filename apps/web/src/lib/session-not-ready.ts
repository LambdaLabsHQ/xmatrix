/** A session read that came back without a browser session. No address or token is involved. */
export type SessionReadGap = "empty_user" | "missing_jwt";

/** Why the reads after a successful sign-in still had nothing to adopt. */
export type SessionNotReadyGap = SessionReadGap | "error";

const ERROR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/u;

/**
 * The sentence the sign-in failure already carries, plus the fixed gap a later
 * report has to show. An error contributes its name only, never its message.
 */
export function sessionNotReadyMessage(gap: SessionNotReadyGap, attempts: number, errorName?: string): string {
  const tries = Number.isInteger(attempts) && attempts >= 0 && attempts <= 1000 ? String(attempts) : "unknown";
  const name = gap === "error" && errorName && ERROR_NAME.test(errorName) ? ` name=${errorName}` : "";
  return `Sign-in succeeded, but the session is still not ready. Please wait a moment and try again. gap=${gap}${name} attempts=${tries}`;
}

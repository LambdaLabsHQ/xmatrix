/**
 * The CLI prefixes every failed refresh with "Session refresh failed", the
 * network and Hub outages included. Only a refused session needs a sign-in;
 * an outage must leave the daemon restarting, or a Wi-Fi drop or Hub deploy
 * stops it until the person signs in again for no reason.
 */
const TRANSIENT_REFRESH_FAILURE = [
  "temporarily unavailable",
  "error sending request",
  "timed out",
  "connection refused",
  "connection reset",
  "dns error",
  "postgresql is unavailable",
  "xmatrix is restarting",
];

const LOGIN_REQUIRED = [
  "not logged in",
  "session refresh failed",
  "invalid refresh token",
  "already used",
  "invalid or expired auth token",
  "saved session cannot be refreshed",
  "session expired",
  "login state lost",
  "waiting for browser login",
];

export function daemonFailureNeedsLogin(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!LOGIN_REQUIRED.some((phrase) => normalized.includes(phrase))) return false;
  const refusedOutright = ["not logged in", "invalid refresh token", "already used", "login state lost",
    "waiting for browser login"].some((phrase) => normalized.includes(phrase));
  return refusedOutright || !TRANSIENT_REFRESH_FAILURE.some((phrase) => normalized.includes(phrase));
}

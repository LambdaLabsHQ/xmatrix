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

const DETAIL_LINES = 8;
const DETAIL_MAX = 600;

/**
 * The CLI's last lines, as they may leave this machine: the home directory,
 * email addresses, URL queries and anything shaped like a token or key are
 * replaced, and only the last few lines, bounded, are kept.
 */
export function redactDaemonDetail(output: string, homeDir: string): string {
  const home = homeDir.replace(/[\\/]+$/, "");
  const lines = output
    .split(/\r?\n/)
    .map((line) => {
      let redacted = home ? line.split(home).join("~") : line;
      redacted = redacted
        .replace(/(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s]+/g, "$1…")
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
        .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1?…")
        .replace(/\b(bearer|token|secret|password|key)(["']?\s*[:=]\s*["']?|\s+)[^\s"',;]+/gi, "$1$2…")
        .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "…");
      return redacted.trim();
    })
    .filter(Boolean)
    .slice(-DETAIL_LINES)
    .join("\n");
  return lines.length > DETAIL_MAX ? lines.slice(-DETAIL_MAX) : lines;
}

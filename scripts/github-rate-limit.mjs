/**
 * GitHub refuses a rate-limited request with 403, the same status it uses for
 * permissions. A primary limit reports `x-ratelimit-remaining: 0` and a reset;
 * a secondary limit reports `retry-after`. Recovery that waits out the limit
 * is temporary, while a permission refusal cannot be retried.
 */
export const RATE_LIMIT_BODY_PATTERN = /rate limit|secondary rate|abuse detection/iu;

export function githubRateLimitRetryAfterMs(response, now = Date.now()) {
  if (!response || response.status !== 403) return undefined;
  const retryAfter = response.headers?.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  if (response.headers?.get("x-ratelimit-remaining") !== "0") return undefined;
  const reset = Number(response.headers?.get("x-ratelimit-reset"));
  return Number.isFinite(reset) ? Math.max(0, reset * 1000 - now) : undefined;
}

/** Transports that only retain the status and body still recognize a limit. */
export function isGithubRateLimitBody(status, text) {
  return status === 403 && typeof text === "string" && RATE_LIMIT_BODY_PATTERN.test(text);
}

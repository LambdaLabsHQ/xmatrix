/**
 * GitHub refuses a rate-limited request with 403, the same status it uses for
 * permissions. A transport that keeps only the status and body still recognizes
 * the limit from GitHub's message, while a permission refusal cannot be
 * retried. Callers with response headers use the reset and Retry-After instead
 * (`githubRetryDelayMs` in release-notes.mjs).
 */
export const RATE_LIMIT_BODY_PATTERN = /rate limit|secondary rate|abuse detection/iu;

export function isGithubRateLimitBody(status, text) {
  return status === 403 && typeof text === "string" && RATE_LIMIT_BODY_PATTERN.test(text);
}

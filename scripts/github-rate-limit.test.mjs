import assert from "node:assert/strict";
import test from "node:test";

import { githubRateLimitRetryAfterMs, isGithubRateLimitBody } from "./github-rate-limit.mjs";

// A transient GitHub limit must be retried, while a permission refusal is
// decided. Both arrive as 403, so only the rate-limit evidence distinguishes them.
test("a 403 rate limit names its wait through retry-after or the primary reset", () => {
  const at = 1_700_000_000_000;
  const response = (status, headers = {}) => new Response("", { status, headers });
  assert.equal(githubRateLimitRetryAfterMs(response(403, { "retry-after": "7" }), at), 7_000);
  assert.equal(githubRateLimitRetryAfterMs(response(403, { "retry-after": "0" }), at), 0);
  assert.equal(githubRateLimitRetryAfterMs(response(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(at / 1000 + 30) }), at), 30_000);
  // A reset already in the past asks for no wait.
  assert.equal(githubRateLimitRetryAfterMs(response(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(at / 1000 - 30) }), at), 0);
});

test("a permission refusal and every other status are not retried", () => {
  const at = 1_700_000_000_000;
  const response = (status, headers = {}) => new Response("", { status, headers });
  assert.equal(githubRateLimitRetryAfterMs(response(403), at), undefined);
  assert.equal(githubRateLimitRetryAfterMs(response(403, { "x-ratelimit-remaining": "12" }), at), undefined);
  assert.equal(githubRateLimitRetryAfterMs(response(403, { "retry-after": "later" }), at), undefined);
  assert.equal(githubRateLimitRetryAfterMs(response(429, { "retry-after": "3" }), at), undefined);
  assert.equal(githubRateLimitRetryAfterMs(response(404), at), undefined);
  assert.equal(githubRateLimitRetryAfterMs(undefined, at), undefined);
});

test("a transport that keeps only the body still recognizes a limited 403", () => {
  assert.equal(isGithubRateLimitBody(403, JSON.stringify({ message: "API rate limit exceeded for installation." })), true);
  assert.equal(isGithubRateLimitBody(403, "You have exceeded a secondary rate limit."), true);
  assert.equal(isGithubRateLimitBody(403, JSON.stringify({ message: "Resource not accessible by integration" })), false);
  assert.equal(isGithubRateLimitBody(401, "API rate limit exceeded"), false);
  assert.equal(isGithubRateLimitBody(403, undefined), false);
});

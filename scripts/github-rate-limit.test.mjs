import assert from "node:assert/strict";
import test from "node:test";

import { isGithubRateLimitBody } from "./github-rate-limit.mjs";

// GitHub uses one status for a temporary limit and a permission refusal. The
// release publisher keeps the status and body only, so its retry decision rests
// on the message; a permission refusal stays decided.
test("a transport that keeps only the body still recognizes a limited 403", () => {
  assert.equal(isGithubRateLimitBody(403, JSON.stringify({ message: "API rate limit exceeded for installation." })), true);
  assert.equal(isGithubRateLimitBody(403, "You have exceeded a secondary rate limit."), true);
  assert.equal(isGithubRateLimitBody(403, "Your request was blocked due to abuse detection."), true);
});

test("a permission refusal and every other status are not retried", () => {
  assert.equal(isGithubRateLimitBody(403, JSON.stringify({ message: "Resource not accessible by integration" })), false);
  assert.equal(isGithubRateLimitBody(401, "API rate limit exceeded"), false);
  assert.equal(isGithubRateLimitBody(403, undefined), false);
  assert.equal(isGithubRateLimitBody(404, "Not Found"), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientBetterAuthStatus,
  normalizeBetterAuthRouteStatus,
} from "../src/better-auth-error-policy.ts";

test("Better Auth route status preserves credential failures and normalizes infrastructure errors", () => {
  assert.equal(normalizeBetterAuthRouteStatus(400), 400);
  assert.equal(normalizeBetterAuthRouteStatus(401), 401);
  assert.equal(normalizeBetterAuthRouteStatus(403), 403);
  assert.equal(normalizeBetterAuthRouteStatus(408), 408);
  assert.equal(normalizeBetterAuthRouteStatus(429), 429);
  assert.equal(normalizeBetterAuthRouteStatus(500), 503);
  assert.equal(normalizeBetterAuthRouteStatus(504), 503);
  assert.equal(normalizeBetterAuthRouteStatus(undefined, 401), 401);
});

test("Better Auth transient status policy never labels a credential rejection as infrastructure failure", () => {
  assert.equal(isTransientBetterAuthStatus(400), false);
  assert.equal(isTransientBetterAuthStatus(401), false);
  assert.equal(isTransientBetterAuthStatus(403), false);
  assert.equal(isTransientBetterAuthStatus(408), true);
  assert.equal(isTransientBetterAuthStatus(429), true);
  assert.equal(isTransientBetterAuthStatus(503), true);
});

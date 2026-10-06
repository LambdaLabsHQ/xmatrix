import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

// email-delivery.ts imports cloudflare:email, so pin its single ownership as a
// source contract: a second copy of the error class would make the login route
// misread a provider configuration failure from the other copy.
test("Hub email delivery is defined once, in email-delivery.ts", async () => {
  const sourceDir = new URL("../src/", import.meta.url);
  const owners = { "class EmailDeliveryConfigurationError": [], "function buildMimeEmail(": [],
    "async function sendEmail(": [], "CLOUDFLARE_EMAIL_CONFIGURATION_ERROR_CODES =": [] };
  for (const name of await readdir(sourceDir, { recursive: true })) {
    if (!name.endsWith(".ts")) continue;
    const text = await readFile(new URL(name, sourceDir), "utf8");
    for (const [needle, files] of Object.entries(owners)) if (text.includes(needle)) files.push(name);
  }
  for (const [needle, files] of Object.entries(owners)) {
    assert.deepEqual(files, ["email-delivery.ts"], needle);
  }
});

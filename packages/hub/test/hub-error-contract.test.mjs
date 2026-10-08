import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { ControlError, SpaceControlError, SpaceSecretError } from "@xmatrix/db";

import { AuthVerificationUnavailable, InvalidAuthTokenError, verifyAuthToken } from "../src/auth.ts";
import { domainErrorResponse } from "../src/error-contract.ts";
import { relayR2PrivateErrorResponse, requestErrorResponse } from "../src/index-shared.ts";
import { registerAgentRegistrationRoutes } from "../src/index-routes-agent-registration.ts";
import { postgresMessageErrorResponse } from "../src/postgres-message-authority.ts";
import { privateRouteResponse } from "../src/private-route-response.ts";
import { RelayR2PrivateApiError } from "../src/relay-r2-private-api.ts";

// The Hub's one error contract: a transient failure is a retryable 503 with
// Retry-After; anything else keeps its own status and is not retryable.

const outage = () => new Error("Connection terminated unexpectedly");
const defect = () => Object.assign(new Error('relation "secret_table" does not exist'), { code: "42P01" });
const moving = () => new ControlError("space_placement_unavailable", 503, "Space placement is unavailable", true);

async function answer(response) {
  const value = await response;
  return { status: value.status, retryAfter: value.headers.get("retry-after"), body: await value.json() };
}

function assertTransient(result, code) {
  assert.equal(result.status, 503);
  assert.equal(result.body.retryable, true);
  assert.equal(result.body.code, code);
  assert.match(result.retryAfter ?? "", /^[1-9][0-9]*$/u);
}

function assertNoDriverText(result) {
  assert.doesNotMatch(JSON.stringify(result.body), /Connection terminated|secret_table/u);
}

test("privateRouteResponse answers an outage as retryable and never echoes the driver", async () => {
  const transient = await answer(privateRouteResponse(async () => { throw outage(); }));
  assertTransient(transient, "postgres_unavailable");
  assertNoDriverText(transient);
  const internal = await answer(privateRouteResponse(async () => { throw defect(); }));
  assert.deepEqual(internal, { status: 500, retryAfter: null,
    body: { error: "Internal error", code: "internal_error", retryable: false } });
  const refused = await answer(privateRouteResponse(async () => {
    throw new ControlError("machine_not_found", 404, "Machine not found");
  }));
  assert.deepEqual(refused.body, { error: "Machine not found", code: "machine_not_found", retryable: false });
  assert.equal(refused.status, 404);
});

test("private storage routes keep a domain rejection's own status and code", async () => {
  const missing = await answer(relayR2PrivateErrorResponse(new ControlError("blob_ref_not_found", 404, "Not found")));
  assert.deepEqual(missing, { status: 404, retryAfter: null,
    body: { error: "Not found", code: "blob_ref_not_found", retryable: false } });
  assertTransient(await answer(relayR2PrivateErrorResponse(moving())), "space_placement_unavailable");
  const transient = await answer(relayR2PrivateErrorResponse(outage()));
  assertTransient(transient, "private_storage_unavailable");
  assertNoDriverText(transient);
  const internal = await answer(relayR2PrivateErrorResponse(defect()));
  assert.equal(internal.status, 500);
  assert.equal(internal.body.retryable, false);
  assertNoDriverText(internal);
  const storage = await answer(relayR2PrivateErrorResponse(new RelayR2PrivateApiError("private_storage_unavailable",
    503, "message attachment failed immutable storage verification", true)));
  assertTransient(storage, "private_storage_unavailable");
});

test("a Space moving shards stays a retryable 503 through the message authority", async () => {
  const placement = new SpaceControlError("space_placement_unavailable", 503, "Space placement is unavailable", true);
  assertTransient(await answer(postgresMessageErrorResponse(placement)), "space_placement_unavailable");
  const broken = await answer(postgresMessageErrorResponse(new SpaceControlError("space_broken", 500, "broken")));
  assert.deepEqual([broken.status, broken.body.retryable], [500, false]);
});

test("typed domain errors carry their retry policy", async () => {
  const refused = await answer(domainErrorResponse(new SpaceSecretError("secret_not_found", 404, "No such secret")));
  assert.deepEqual(refused, { status: 404, retryAfter: null,
    body: { error: "No such secret", code: "secret_not_found", retryable: false } });
  assertTransient(await answer(domainErrorResponse(
    new SpaceSecretError("secret_request_failed", 503, "Space placement is unavailable", true))), "secret_request_failed");
});

test("an Agent registration outage reaches the client as retryable", async () => {
  const app = new Hono();
  registerAgentRegistrationRoutes(app, { authenticate: async () => ({ id: "owner" }),
    get: async () => { throw moving(); } });
  const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" };
  assertTransient(await answer(app.request("/api/spaces/space/agent-registrations/query", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(key) }, {})),
  "space_placement_unavailable");
});

/** A Better Auth token checked against a JWKS endpoint answered by `respond`. */
async function verifyAgainstJwks(respond) {
  const { privateKey } = await generateKeyPair("ES256");
  const env = { HUB_URL: "https://hub.example.test",
    BETTER_AUTH_JWKS_URL: `https://hub.example.test/jwks/${crypto.randomUUID()}` };
  const token = await new SignJWT({ email: "person@example.test" }).setProtectedHeader({ alg: "ES256" })
    .setSubject("user-1").setIssuer(env.HUB_URL).setAudience(env.HUB_URL).setExpirationTime("5m").sign(privateKey);
  const original = globalThis.fetch;
  globalThis.fetch = async () => respond();
  try {
    return await verifyAuthToken(token, env).then(() => null, (error) => error);
  } finally {
    globalThis.fetch = original;
  }
}

test("a JWKS that cannot be fetched is a retryable outage, never a sign-out", async () => {
  for (const respond of [
    () => { throw new TypeError("fetch failed"); },
    () => new Response("upstream", { status: 502 }),
  ]) {
    const error = await verifyAgainstJwks(respond);
    assert.ok(error instanceof AuthVerificationUnavailable, String(error));
    const app = new Hono();
    app.get("/", (c) => requestErrorResponse(c, error));
    assertTransient(await answer(app.request("/")), "auth_verification_unavailable");
  }
});

test("a token the JWKS refuses is still a definite 401", async () => {
  const { publicKey } = await generateKeyPair("ES256");
  const other = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig" };
  const error = await verifyAgainstJwks(() => Response.json({ keys: [other] }));
  assert.ok(error instanceof InvalidAuthTokenError, String(error));
});

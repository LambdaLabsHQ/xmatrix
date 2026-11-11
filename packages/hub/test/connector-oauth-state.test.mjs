import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthStateProviderId, signOAuthState, verifyOAuthStateClaims } from "../src/connectors/oauth-state.ts";
import { signGitHubAppState } from "../src/index-shared.ts";

const secret = "private-connector-client-secret";
const claims = {
  providerId: "x",
  spaceId: "space-fixture-0000000000000000000001",
  userId: "human-fixture-0000000000000000000001",
  nonce: "00000000-0000-4000-8000-000000000000",
  expiresAt: Date.now() + 600_000,
  clientId: "client-fixture-0000000000000000000000000",
  redirectUri: "https://xmatrix-hub.xmatrix.sh/api/connectors/oauth/callback",
  connectionSnapshot: { connectionVersion: 1, credentialVersion: 0,
    connectionGeneration: "app-connection:2026-11-11T13:40:18.930Z:connector-discord-start:3a03609e-e97d-44c5-b147-4b1ded585d41" },
};

test("a connect state stays inside the 500 characters X accepts, and still carries every claim", async () => {
  const state = await signOAuthState(claims, secret);
  // X answers invalid_request before consent when state is longer than 500.
  assert.ok(state.length <= 500, `state is ${state.length} characters`);
  assert.deepEqual(await verifyOAuthStateClaims(state, secret), claims);
  assert.equal(await oauthStateProviderId(state), "x");
});

test("unnamed future claims travel with the state instead of being dropped", async () => {
  const state = await signOAuthState({ ...claims, expectedAuthority: "brand",
    connectionSnapshot: { ...claims.connectionSnapshot, expectedOwner: "human-owner" } }, secret);
  const verified = await verifyOAuthStateClaims(state, secret);
  assert.equal(verified.expectedAuthority, "brand");
  assert.equal(verified.connectionSnapshot.expectedOwner, "human-owner");
  assert.equal(verified.connectionSnapshot.connectionGeneration, claims.connectionSnapshot.connectionGeneration);
});

test("a state minted in the earlier JSON payload still finishes its flow", async () => {
  const legacy = await signGitHubAppState({ providerId: "x", spaceId: "space-1", userId: "human-1",
    nonce: "00000000-0000-4000-8000-000000000000", expiresAt: Date.now() + 60_000 }, secret);
  assert.equal(await oauthStateProviderId(legacy), "x");
  assert.equal((await verifyOAuthStateClaims(legacy, secret)).userId, "human-1");
});

test("a forged, altered, expired or oversized state verifies as nothing", async () => {
  const state = await signOAuthState(claims, secret);
  const [payload, signature] = state.split(".");
  assert.equal(await verifyOAuthStateClaims(state, "rotated-secret"), undefined, "another secret");
  assert.equal(await verifyOAuthStateClaims(`${payload}.${signature.slice(0, -1)}A`, secret), undefined, "another signature");
  const altered = `${payload.slice(0, 10)}${payload[10] === "A" ? "B" : "A"}${payload.slice(11)}.${signature}`;
  assert.equal(await verifyOAuthStateClaims(altered, secret), undefined, "an altered payload");
  assert.equal(await verifyOAuthStateClaims(await signOAuthState({ ...claims, expiresAt: Date.now() - 1 }, secret), secret), undefined, "expiry");
  assert.equal(await verifyOAuthStateClaims("garbage", secret), undefined);
  assert.equal(await verifyOAuthStateClaims(`${"z".concat("A".repeat(5_000))}.${signature}`, secret), undefined, "oversized");
  assert.equal(await verifyOAuthStateClaims(`${"z".concat("A".repeat(200))}.${signature}`, secret), undefined, "not deflate data");
  assert.equal(await oauthStateProviderId("not-a-state"), "");
});

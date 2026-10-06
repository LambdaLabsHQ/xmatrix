import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { oauthAuthorizeUrl, oauthClient, exchangeOAuthGrant, refreshOAuthFields, verifyOAuthState } from "../src/connectors/oauth.ts";
import { pagerDutyGrantContext, validatePagerDutyGrant } from "../src/connectors/pagerduty-oauth.ts";
import { PAGERDUTY_ACTIONS, verifyPagerDuty } from "../src/connectors/actions/pagerduty.ts";
import { assertSavedRotation, runRefreshedAction } from "./support/connection-credentials-fixture.mjs";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const exchangeOAuthCode = async (...args) => (await exchangeOAuthGrant(...args)).fields;

const settings = { CONNECTOR_PAGERDUTY_CLIENT_ID: "pd-fixture-client", CONNECTOR_PAGERDUTY_CLIENT_SECRET: "pd-fixture-secret" };
const client = oauthClient(settings, "pagerduty");
const callback = "https://hub.example/api/connectors/oauth/callback";
const issuer = "https://app.pagerduty.com/global/oauth/anonymous";
const publicKeys = "https://identity.pagerduty.com/global/oauth/anonymous/jwks";
const scopes = "abilities.read incidents.read incidents.write openid";
const grant = { access_token: "pd-fixture-access", refresh_token: "pd-fixture-refresh", token_type: "Bearer", expires_in: 86_400, scope: scopes };
const account = { oauthClientId: client.clientId, oauthRegion: "eu", oauthAccountId: "Q1ACCOUNT", oauthSubdomain: "made-by-robot" };
const saved = { ...account, oauthToken: grant.access_token, oauthRefreshToken: grant.refresh_token,
  oauthScopes: scopes, oauthExpiresAt: String(Date.now() + 3_600_000), apiRegion: "us", fromEmail: "untrusted-manual@example.com" };
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "pd-fixture-kid", use: "sig", alg: "RS256" };

async function signedGrant(changes = {}, tokenChanges = {}) {
  const { iss = issuer, exp = "1h", ...overrides } = changes;
  const claims = { aud: ["https://api.eu.pagerduty.com", client.clientId], azp: client.clientId, purpose: "id",
    at_hash: createHash("sha256").update(grant.access_token).digest().subarray(0, 16).toString("base64url"),
    account_id: account.oauthAccountId, subdomain: account.oauthSubdomain,
    sub: "private-subject@example.com", user_id: "PRIVATE_USER_ID", region: "provider-region-label", ...overrides };
  const id_token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid, jku: "https://attacker.example/untrusted-jwks" })
    .setIssuer(iss).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  return { ...grant, id_token, ...tokenChanges };
}

async function withProvider(responses, operation) {
  const stub = stubFetchResponses(responses);
  try { return { value: await operation(), calls: stub.calls }; }
  finally { stub.restore(); }
}

async function authorize(now) {
  return new URL(await oauthAuthorizeUrl(client, { spaceId: "pd-space", userId: "pd-admin", redirectUri: callback, now }));
}

test("S256 proof is flow-specific, withheld from browser state, and sent only after signed-state verification", async () => {
  const first = await authorize(), second = await authorize();
  assert.equal(first.origin, "https://identity.pagerduty.com");
  assert.equal(first.searchParams.get("scope"), "abilities.read incidents.read incidents.write");
  assert.equal(first.searchParams.get("code_challenge_method"), "S256");
  assert.notEqual(first.searchParams.get("code_challenge"), second.searchParams.get("code_challenge"));
  const state = first.searchParams.get("state");
  const claims = JSON.parse(Buffer.from(state.split(".")[0], "base64url"));
  assert.equal(claims.clientId, client.clientId);
  assert.equal(claims.redirectUri, callback);
  assert.doesNotMatch(JSON.stringify(claims), /verifier|pd-fixture-secret/);
  const proof = await verifyOAuthState(settings, state);
  assert.equal(proof.spaceId, "pd-space");
  assert.equal(proof.userId, "pd-admin");
  const { value, calls } = await withProvider([{ body: await signedGrant() }, { body: { keys: [jwk] } }],
    () => exchangeOAuthCode(client, "one-use-code", callback, state));
  const form = Object.fromEntries(calls[0].body);
  assert.match(form.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash("sha256").update(form.code_verifier).digest("base64url"), first.searchParams.get("code_challenge"));
  assert.equal(form.client_secret, client.clientSecret);
  assert.equal(form.grant_type, "authorization_code");
  assert.equal(calls[1].url, publicKeys);
  assert.deepEqual(Object.fromEntries(Object.entries(value).filter(([key]) => key in account)), account);
  assert.equal(value.oauthScopes, scopes);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_USER_ID|private-subject|id_token|verifier|pd-fixture-secret/);
});

test("missing, forged, expired, wrong-client and callback-mismatched PKCE never reach token exchange", async () => {
  const state = (await authorize()).searchParams.get("state");
  const expired = (await authorize(Date.now() - 11 * 60_000)).searchParams.get("state");
  const stub = stubFetchResponses([]);
  try {
    for (const bad of [undefined, "bad", state + "x", expired]) await assert.rejects(exchangeOAuthCode(client, "code", callback, bad), /proof/);
    await assert.rejects(exchangeOAuthCode(client, "code", "https://other.example/cb", state), /proof/);
    const replacement = { ...client, clientId: "changed-client" };
    assert.equal(await verifyOAuthState({ ...settings, CONNECTOR_PAGERDUTY_CLIENT_ID: replacement.clientId }, state), undefined);
    await assert.rejects(exchangeOAuthCode(replacement, "code", callback, state), /proof/);
    await assert.rejects(exchangeOAuthCode({ ...client, clientSecret: "changed-secret" }, "code", callback, state), /proof/);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test("classic, partial, broad, duplicate, nonrotating and malformed grants cannot become Scoped OAuth", () => {
  validatePagerDutyGrant(grant);
  for (const change of [{ scope: "openid" }, { scope: "read write" }, { scope: "abilities.read incidents.read" },
    { scope: scopes + " users.read" }, { scope: scopes + " incidents.read" }, { token_type: "Basic" },
    { refresh_token: "" }, { access_token: "token\nheader" }, { expires_in: true }, { expires_in: [3600] },
    { expires_in: 0 }, { expires_in: 86_401 }, { expires_in: 1.5 }]) assert.throws(() => validatePagerDutyGrant({ ...grant, ...change }), /scoped, rotating/);
});

test("signed US/EU audiences choose the API region independently of unsigned metadata", async () => {
  for (const [api, region] of [["https://api.pagerduty.com", "us"], ["https://api.eu.pagerduty.com", "eu"]]) {
    const payload = await signedGrant({ aud: [api, client.clientId], region: "untrusted-enum" });
    const run = await withProvider([{ body: { keys: [jwk] } }], () => pagerDutyGrantContext(client.clientId, payload));
    assert.equal(run.value.oauthRegion, region);
    assert.equal(run.calls[0].url, publicKeys);
  }
});

test("wrong signatures, issuer, audience, access-token binding, expiry and account context fail closed", async () => {
  const changes = [{ aud: ["https://attacker.example", client.clientId] }, { aud: ["https://api.pagerduty.com", "other-client"] },
    { aud: ["https://api.pagerduty.com", "https://api.eu.pagerduty.com", client.clientId] }, { azp: "another-client" },
    { purpose: "access" }, { at_hash: "wrong" }, { account_id: "../account" }, { subdomain: "../other" }];
  const inputs = await Promise.all(changes.map(change => signedGrant(change)));
  inputs.push(await signedGrant({}, { access_token: "another-access-token" }));
  inputs.push(await signedGrant({ iss: "https://identity.pagerduty.com/global/oauth/anonymous" }),
    await signedGrant({ exp: 1 }));
  inputs.push({ ...grant, id_token: "forged.payload.signature" }, { ...grant });
  for (const payload of inputs) await assert.rejects(withProvider([{ body: { keys: [jwk] } }],
    () => pagerDutyGrantContext(client.clientId, payload)), /scoped, rotating/);
  await assert.rejects(withProvider([{ body: { keys: [jwk] } }], async () => pagerDutyGrantContext(client.clientId,
    await signedGrant({ account_id: "Q2OTHER" }), saved)), /scoped, rotating/);
  const altered = await signedGrant();
  altered.id_token = altered.id_token.slice(0, -5) + "aaaaa";
  await assert.rejects(withProvider([{ body: { keys: [jwk] } }], () => pagerDutyGrantContext(client.clientId, altered)), /scoped, rotating/);
});

test("OAuth actions use the managed regional Bearer without From; manual writes still require From", async () => {
  const read = PAGERDUTY_ACTIONS.read_incident;
  const incident = { id: "Q1INCIDENT", type: "incident", title: "E2E task", status: "triggered",
    html_url: "https://made-by-robot.eu.pagerduty.com/incidents/Q1INCIDENT" };
  const run = await withProvider([{ body: { abilities: [] } }, { body: { incident } }, { body: { notes: [] } }, { body: {} }], async () => {
    await verifyPagerDuty(saved);
    await read.execute({ credentials: saved }, { incident: "Q1INCIDENT" });
    await PAGERDUTY_ACTIONS.note.execute({ credentials: saved }, { incident: "Q1INCIDENT", text: "test" });
  });
  assert.ok(run.calls.every(call => call.url.startsWith("https://api.eu.pagerduty.com/") &&
    call.headers.get("authorization") === `Bearer ${saved.oauthToken}` && call.headers.get("from") === null));
  await assert.rejects(withProvider([], () => PAGERDUTY_ACTIONS.resolve.execute({ credentials: { apiKey: "manual" } },
    { incident: "Q1INCIDENT" })), /acting email/);
  const manual = await withProvider([{ body: {} }], () => PAGERDUTY_ACTIONS.resolve.execute({ credentials: {
    apiKey: "manual", fromEmail: "actor@example.com", apiRegion: "eu" } }, { incident: "Q1INCIDENT" }));
  assert.equal(manual.calls[0].headers.get("from"), "actor@example.com");
  await assert.rejects(verifyPagerDuty({}), /needs OAuth/);
  await verifyPagerDuty({ webhookSecret: "signed-hook-only" });
  await assert.rejects(withProvider([], () => verifyPagerDuty({ apiKey: "manual", apiRegion: "https://attacker.example" })), /us or eu/);
  await assert.rejects(withProvider([{ body: { incident: { ...incident, html_url: "https://other.eu.pagerduty.com/incidents/Q1INCIDENT" } } }],
    () => read.execute({ credentials: saved }, { incident: "Q1INCIDENT" })), /incident link/);
});

async function refreshing({ credentials = { ...saved, oauthExpiresAt: "1" }, response = { ...grant,
  access_token: "rotated-access", refresh_token: "rotated-refresh" }, conflict = false, status = 200, env = settings } = {}) {
  return runRefreshedAction({ env, providerId: "pagerduty", credentials, response, conflict, status,
    action: current => PAGERDUTY_ACTIONS.resolve.execute({ credentials: current }, { incident: "Q1INCIDENT" }) });
}

test("rotated pair is saved with version CAS before one write; OAuth 401 and CAS conflict never replay writes", async () => {
  const run = await refreshing();
  assertSavedRotation(run, "rotated-access", "rotated-refresh");
  assert.deepEqual(run.calls.map(call => call.method), ["POST", "PUT"]);
  assert.equal(run.calls[1].headers.get("authorization"), "Bearer rotated-access");
  for (const options of [{ conflict: true }, { status: 401 }]) {
    const rejected = await refreshing(options);
    assert.ok(rejected.error); assert.equal(rejected.calls.length, options.conflict ? 1 : 2);
  }
});

test("missing evidence, canonical application changes and failed rotation prevent provider writes", async () => {
  for (const options of [{ env: {} }, { env: { ...settings, CONNECTOR_PAGERDUTY_CLIENT_ID: "new-client" } },
    { credentials: { ...saved, oauthRefreshToken: "" } }, { credentials: { ...saved, oauthExpiresAt: "NaN" } },
    { credentials: { ...saved, oauthRegion: "unknown" } }, { credentials: { ...saved, oauthAccountId: "" } },
    { credentials: { ...saved, oauthScopes: "openid" } }]) {
    const run = await refreshing(options);
    assert.ok(run.error); assert.equal(run.calls.length, 0); assert.equal(run.puts.length, 0);
  }
  for (const response of [{ ...grant, refresh_token: "" }, { ...grant, scope: "openid" }]) {
    const run = await refreshing({ response });
    assert.ok(run.error); assert.equal(run.calls.length, 1); assert.equal(run.puts.length, 0);
  }
  const valid = await withProvider([], () => refreshOAuthFields(settings, "pagerduty", saved));
  assert.equal(valid.value, undefined);
});


test("refresh ID tokens must preserve the signed account, region and client; missing/failed key proofs never follow supplied URLs", async () => {
  const state = (await authorize()).searchParams.get("state");
  const token = await signedGrant();
  for (const keys of [[], [{ ...jwk, kid: "unrelated-key" }], null]) {
    await assert.rejects(withProvider([{ body: token }, { body: { keys } }],
      () => exchangeOAuthCode(client, "code", callback, state)));
  }
  for (const claims of [{ aud: ["https://api.pagerduty.com", client.clientId] }, { subdomain: "other-account" }]) {
    await assert.rejects(withProvider([{ body: await signedGrant(claims) }, { body: { keys: [jwk] } }],
      () => refreshOAuthFields(settings, "pagerduty", { ...saved, oauthExpiresAt: "1" })), /scoped, rotating/);
  }
  const refreshed = await withProvider([{ body: token }, { body: { keys: [jwk] } }],
    () => refreshOAuthFields(settings, "pagerduty", { ...saved, oauthExpiresAt: "1" }));
  assert.equal(refreshed.value.oauthAccountId, account.oauthAccountId);
  assert.deepEqual(refreshed.calls.map(call => call.url), ["https://identity.pagerduty.com/oauth/token", publicKeys]);
  await assert.rejects(withProvider([{ status: 401, body: { error_description: "PRIVATE_PROVIDER_TOKEN" } }],
    () => exchangeOAuthCode(client, "code", callback, state)), error => !error.message.includes("PRIVATE_PROVIDER_TOKEN"));
});

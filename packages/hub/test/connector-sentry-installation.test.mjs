import assert from "node:assert/strict";
import { test } from "node:test";
import { jwtVerify } from "jose";
import { exchangeSentryInstallation, sentryInstallationClient } from "../src/connectors/sentry-installation.ts";
import { oauthClient, refreshOAuthFields } from "../src/connectors/oauth.ts";
import { SENTRY_ACTIONS, verifySentry } from "../src/connectors/actions/sentry.ts";
import { assertSavedRotation, runRefreshedAction } from "./support/connection-credentials-fixture.mjs";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const now = Date.parse("2026-10-04T00:00:00Z");
const settings = { CONNECTOR_SENTRY_CLIENT_ID: "fixture-client", CONNECTOR_SENTRY_CLIENT_SECRET: "fixture-secret",
  CONNECTOR_SENTRY_APP_UUID: "11111111-2222-4333-8444-555555555555", CONNECTOR_SENTRY_APP_SLUG: "xmatrix" };
const client = sentryInstallationClient(settings);
const selected = { code: "one-use-code", installationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", organization: "made-by-robot" };
const installation = { uuid: selected.installationId, app: { uuid: client.appUuid, slug: client.appSlug },
  organization: { id: 123, slug: selected.organization }, status: "pending", code: "private-code-in-provider-metadata" };
const installed = { ...installation, status: "installed" };
const grant = { token: "fixture-access", refreshToken: "fixture-refresh", expiresAt: "2026-10-04T08:00:00Z",
  scopes: ["org:read", "project:read", "event:write", "event:read"], user: { email: "private-user" }, state: "private-state" };
const saved = { oauthToken: grant.token, oauthRefreshToken: grant.refreshToken,
  oauthExpiresAt: String(now + 8 * 3_600_000), oauthClientId: client.clientId, oauthAppUuid: client.appUuid,
  oauthAppSlug: client.appSlug, oauthInstallationId: selected.installationId, oauthOrganization: selected.organization,
  oauthOrganizationId: "123", oauthScopes: "event:read event:write org:read project:read",
  organization: "attacker-org", baseUrl: "https://attacker.example", authToken: "stale-manual" };
const url = `https://sentry.io/api/0/sentry-app-installations/${selected.installationId}/`;

async function withProvider(responses, operation) {
  const stub = stubFetchResponses(responses, { decodeBody: body => typeof body === "string" ? JSON.parse(body) : body });
  try { return { value: await operation(), calls: stub.calls }; }
  finally { stub.restore(); }
}

test("native UI Issue Read & Write grants accept both scope orders and save the exact four scopes", async () => {
  for (const scopes of [["event:read", "event:write", "org:read", "project:read"], [...grant.scopes].reverse()]) {
    const run = await withProvider([{ body: { ...grant, scopes } }, { body: installed }],
      () => exchangeSentryInstallation(client, selected, now));
    assert.equal(run.value.oauthScopes, "event:read event:write org:read project:read");
    assert.equal(run.calls.length, 2);
  }
});

test("native app configuration cannot offer the legacy user OAuth button, including a partial native identity", () => {
  assert.equal(oauthClient(settings, "sentry"), undefined);
  assert.ok(oauthClient({ CONNECTOR_SENTRY_CLIENT_ID: client.clientId, CONNECTOR_SENTRY_CLIENT_SECRET: client.clientSecret }, "sentry"));
  for (const change of [{ CONNECTOR_SENTRY_APP_UUID: "" }, { CONNECTOR_SENTRY_APP_SLUG: "" },
    { CONNECTOR_SENTRY_CLIENT_ID: "" }, { CONNECTOR_SENTRY_CLIENT_SECRET: "https://example.com/authorize" },
    { CONNECTOR_SENTRY_APP_UUID: "../other" }, { CONNECTOR_SENTRY_APP_SLUG: "xmatrix\n" }]) {
    const configured = { ...settings, ...change };
    assert.equal(sentryInstallationClient(configured), undefined);
    assert.equal(oauthClient(configured, "sentry"), undefined);
  }
});

test("an expired legacy user OAuth grant cannot silently reuse its access token after native application configuration", async () => {
  const run = await withProvider([], async () => assert.rejects(refreshOAuthFields(settings, "sentry", {
    oauthToken: "legacy-access", oauthRefreshToken: "legacy-refresh", oauthExpiresAt: "1" }, now), /user OAuth is unavailable/));
  assert.equal(run.calls.length, 0);
});

test("installation exchange proves the reviewed app/organization before verification and retains no provider profiles or callback code", async () => {
  const run = await withProvider([{ body: grant }, { body: installation }, { body: installed }],
    () => exchangeSentryInstallation(client, selected, now));
  assert.deepEqual(run.calls.map(call => [call.method, call.url]), [["POST", `${url}authorizations/`], ["GET", url], ["PUT", url]]);
  assert.deepEqual(run.calls[0].body, { grant_type: "authorization_code", code: selected.code,
    client_id: client.clientId, client_secret: client.clientSecret });
  assert.deepEqual(run.calls[2].body, { status: "installed" });
  assert.ok(run.calls.slice(1).every(call => call.headers.get("authorization") === "Bearer fixture-access"));
  assert.deepEqual(run.value, Object.fromEntries(Object.entries(saved).filter(([key]) => key.startsWith("oauth"))));
  assert.doesNotMatch(JSON.stringify(run.value), /private-|one-use-code|fixture-secret/);
  const repeat = await withProvider([{ body: grant }, { body: installed }], () => exchangeSentryInstallation(client, selected, now));
  assert.equal(repeat.calls.length, 2, "an already-installed identity needs no mutation replay");
});

test("unsafe callback input and app configuration fail before consuming a code", async () => {
  for (const change of [{ installationId: "../other" }, { organization: "../other" }, { code: "" }, { code: "code\n" }]) {
    const run = await withProvider([], async () => assert.rejects(exchangeSentryInstallation(client, { ...selected, ...change }, now)));
    assert.equal(run.calls.length, 0);
  }
  const run = await withProvider([], async () => assert.rejects(exchangeSentryInstallation({ ...client, appUuid: "unknown" }, selected, now)));
  assert.equal(run.calls.length, 0);
});

test("cross-installation, app, organization, unsafe numeric identity or deletion cannot reach verification PUT", async () => {
  for (const change of [{ uuid: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, { app: { ...installed.app, uuid: crypto.randomUUID() } },
    { app: { ...installed.app, slug: "other" } }, { organization: { ...installed.organization, slug: "other" } },
    { organization: { slug: selected.organization, id: Number.MAX_SAFE_INTEGER + 1 } },
    { organization: { slug: selected.organization, id: true } }, { status: "pending_deletion" }]) {
    const run = await withProvider([{ body: grant }, { body: { ...installation, ...change } }], async () =>
      assert.rejects(exchangeSentryInstallation(client, selected, now), /scoped installation/));
    assert.equal(run.calls.length, 2);
    assert.ok(run.calls.every(call => call.method !== "PUT"));
  }
  for (const change of [{ status: "pending" }, { organization: { ...installed.organization, id: 456 } }]) {
    await withProvider([{ body: grant }, { body: installation }, { body: { ...installed, ...change } }], async () =>
      assert.rejects(exchangeSentryInstallation(client, selected, now), /scoped installation/));
  }
});

test("partial, broad, duplicate, malformed and generic snake_case token responses cannot become native grants", async () => {
  for (const change of [{ token: "" }, { refreshToken: "" }, { token: "header\nvalue" }, { refreshToken: grant.token },
    { expiresAt: "2026-10-04T00:00:00Z" }, { expiresAt: "2026-10-06T00:00:00Z" },
    { expiresAt: now + 3_600_000 }, { expiresAt: "2026-10-04T08:00:00" },
    ...grant.scopes.map(missing => ({ scopes: grant.scopes.filter(scope => scope !== missing) })), { scopes: [...grant.scopes, "org:write"] },
    { scopes: ["org:read", "org:read", "event:write", "event:read"] }, { scopes: null }]) {
    await withProvider([{ body: { ...grant, ...change } }], async () =>
      assert.rejects(exchangeSentryInstallation(client, selected, now), /scoped installation/));
  }
  await withProvider([{ body: { access_token: "access", refresh_token: "refresh", expires_in: 3600 } }], async () =>
    assert.rejects(exchangeSentryInstallation(client, selected, now), /scoped installation/));
});

test("Check uses the exact installed UUID and identity; native actions ignore stale writable organization and origin", async () => {
  const run = await withProvider([{ body: installed }, { body: { groupId: "456" } }, { body: {} }], async () => {
    await verifySentry(saved);
    await SENTRY_ACTIONS.resolve.execute({ credentials: saved }, { issue: "WEB-1A" });
  });
  assert.equal(run.calls[0].url, url);
  assert.deepEqual(run.calls.slice(1).map(call => call.url), [
    "https://sentry.io/api/0/organizations/made-by-robot/shortids/WEB-1A/",
    "https://sentry.io/api/0/organizations/made-by-robot/issues/456/",
  ]);
  assert.ok(run.calls.every(call => call.headers.get("authorization") === "Bearer fixture-access"));
  for (const response of [installation, { ...installed, organization: { ...installed.organization, id: 456 } }]) {
    await withProvider([{ body: response }], async () => assert.rejects(verifySentry(saved), /scoped installation/));
  }
});

test("even unexpired grants require the complete managed identity and current canonical application", async () => {
  const valid = await withProvider([], () => refreshOAuthFields(settings, "sentry", saved, now));
  assert.equal(valid.value, undefined);
  for (const change of [{ oauthRefreshToken: "" }, { oauthExpiresAt: "NaN" }, { oauthOrganization: "../other" },
    { oauthOrganizationId: "" }, { oauthAppUuid: "" }, { oauthClientId: "" }, { oauthScopes: "org:read" },
    { oauthScopes: "event:write org:read project:read" },
    { oauthScopes: `${saved.oauthScopes} org:write` },
    { oauthExpiresAt: String(now + 86_400_001) }]) {
    const run = await withProvider([], async () => assert.rejects(refreshOAuthFields(settings, "sentry", { ...saved, ...change }, now)));
    assert.equal(run.calls.length, 0);
  }
  for (const env of [{}, { ...settings, CONNECTOR_SENTRY_CLIENT_ID: "new-client" },
    { ...settings, CONNECTOR_SENTRY_APP_UUID: crypto.randomUUID() }, { ...settings, CONNECTOR_SENTRY_APP_SLUG: "another" }]) {
    const run = await withProvider([], async () => assert.rejects(refreshOAuthFields(env, "sentry", saved, now)));
    assert.equal(run.calls.length, 0);
  }
});

async function refreshedWrite({ conflict = false, status = 200, response } = {}) {
  const actualNow = Date.now();
  const nextGrant = response ?? { ...grant, token: "rotated-access", refreshToken: "rotated-refresh",
    expiresAt: new Date(actualNow + 8 * 3_600_000).toISOString() };
  return runRefreshedAction({ env: settings, providerId: "sentry", credentials: { ...saved, oauthExpiresAt: "1" },
    response: nextGrant, conflict, status, decodeBody: body => JSON.parse(body),
    action: current => SENTRY_ACTIONS.resolve.execute({ credentials: current }, { issue: "456" }) });
}

test("complete rotated pair is persisted before action, with version CAS and no retry after conflict or uncertain write", async () => {
  const run = await refreshedWrite();
  assertSavedRotation(run, "rotated-access", "rotated-refresh");
  assert.deepEqual(run.calls.map(call => call.method), ["POST", "PUT"]);
  assert.equal(run.calls[0].url, `${url}authorizations/`);
  // The manual JWT grant needs no saved refresh token, so a rotation lost in transit cannot strand the grant.
  assert.deepEqual(run.calls[0].body, { grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer" });
  assert.ok(!JSON.stringify(run.calls[0].body).includes(client.clientSecret));
  const [scheme, assertion] = run.calls[0].headers.get("authorization").split(" ");
  assert.equal(scheme, "Bearer");
  const { payload, protectedHeader } = await jwtVerify(assertion, new TextEncoder().encode(client.clientSecret),
    { algorithms: ["HS256"], issuer: client.clientId, subject: client.clientId });
  assert.equal(protectedHeader.alg, "HS256");
  assert.match(payload.jti, /^[0-9a-f-]{36}$/u);
  assert.ok(payload.exp - payload.iat <= 60);
  assert.equal(run.calls[1].headers.get("authorization"), "Bearer rotated-access");
  for (const options of [{ conflict: true }, { status: 401 }, { status: 503 }]) {
    const rejected = await refreshedWrite(options);
    assert.ok(rejected.error);
    assert.equal(rejected.calls.length, options.conflict ? 1 : 2);
  }
  const malformed = await refreshedWrite({ response: { ...grant, refreshToken: "" } });
  assert.ok(malformed.error);
  assert.equal(malformed.calls.length, 1);
  assert.equal(malformed.puts.length, 0);
  for (const scopes of [grant.scopes.filter(scope => scope !== "event:read"), [...grant.scopes, "org:write"],
    ["event:read", "event:write", "org:read", "org:read"]]) {
    const rejected = await refreshedWrite({ response: { ...grant, token: "rotated-access",
      refreshToken: "rotated-refresh", expiresAt: new Date(Date.now() + 28_800_000).toISOString(), scopes } });
    assert.ok(rejected.error);
    assert.equal(rejected.calls.length, 1, "a rejected rotation cannot dispatch an issue write");
    assert.equal(rejected.puts.length, 0, "a rejected rotation cannot replace saved credentials");
  }
  const unchanged = await withProvider([{ body: grant }], async () =>
    assert.rejects(refreshOAuthFields(settings, "sentry", { ...saved, oauthExpiresAt: "1" }, now), /scoped installation/));
  assert.equal(unchanged.calls.length, 1);
});

test("provider errors and redirects never expose authorization codes, refresh tokens or private response values", async () => {
  for (const status of [302, 401, 403, 429, 503]) {
    const result = await withProvider([{ status, body: { error_description: "private-provider-token one-use-code" } }], async () =>
      assert.rejects(exchangeSentryInstallation(client, selected, now), error =>
        /Sentry installation request failed/.test(error.message) && !/private-|one-use-code/.test(error.message)));
    assert.equal(result.calls.length, 1);
  }
  const error = await withProvider([{ status: 401, body: { message: "private-refresh-token" } }], async () =>
    assert.rejects(refreshOAuthFields(settings, "sentry", { ...saved, oauthExpiresAt: "1" }, now),
      error => !error.message.includes("private-refresh")));
  assert.equal(error.calls.length, 1);
});

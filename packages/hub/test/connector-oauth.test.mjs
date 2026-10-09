import { stubFetchResponses } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../protocol/src/app-connector-manifests.ts";
import { exchangeOAuthGrant, grantFieldsForgottenOnDisconnect, oauthAuthorizeUrl, oauthClient, oauthProviderIds, oauthTokenFields, refreshOAuthFields,
  verifyOAuthState } from "../src/connectors/oauth.ts";
import { connectorProvider } from "../src/connectors/registry.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";

const exchangeOAuthCode = async (...args) => (await exchangeOAuthGrant(...args)).fields;

const env = {
  CONNECTOR_LINEAR_CLIENT_ID: "lin-id", CONNECTOR_LINEAR_CLIENT_SECRET: "lin-secret",
  CONNECTOR_NOTION_CLIENT_ID: "no-id", CONNECTOR_NOTION_CLIENT_SECRET: "no-secret",
  CONNECTOR_JIRA_CLIENT_ID: "at-id", CONNECTOR_JIRA_CLIENT_SECRET: "at-secret",
  CONNECTOR_SLACK_CLIENT_ID: "sl-id",
};

const stubFetch = responses => stubFetchResponses(responses, {
  allowUnexpected: true,
  decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body)
    : typeof body === "string" ? JSON.parse(body) : undefined,
});

test("one-click OAuth is offered only for providers whose client id and secret are both configured", () => {
  assert.deepEqual(oauthProviderIds(env).sort(), ["jira", "linear", "notion"]);
  assert.equal(oauthClient(env, "slack"), undefined, "a client id without a secret is not configured");
  assert.equal(oauthClient(env, "webhook"), undefined);
  for (const id of ["slack", "linear", "sentry", "gitlab", "jira", "notion", "netlify"]) {
    const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => candidate.id === id);
    assert.ok(manifest.oauth, `${id} declares OAuth`);
    assert.ok(manifest.credentials.some((field) => field.id === manifest.oauth.tokenField), `${id} stores its token`);
  }
});

test("the authorize URL carries a state bound to provider, Space and admin, which a forgery or expiry fails", async () => {
  const client = oauthClient(env, "jira");
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space-1", userId: "admin-1",
    redirectUri: "https://hub.test/api/connectors/oauth/callback" }));
  assert.equal(url.origin + url.pathname, "https://auth.atlassian.com/authorize");
  assert.equal(url.searchParams.get("client_id"), "at-id");
  assert.equal(url.searchParams.get("audience"), "api.atlassian.com");
  assert.equal(url.searchParams.get("scope"), "read:jira-work write:jira-work offline_access");
  const state = url.searchParams.get("state");
  const verified = await verifyOAuthState(env, state);
  assert.equal(verified.client.manifest.id, "jira");
  assert.equal(verified.spaceId, "space-1");
  assert.equal(verified.userId, "admin-1");
  const [payload, signature] = state.split(".");
  const tampered = JSON.parse(Buffer.from(payload, "base64url").toString());
  tampered.spaceId = "space-2";
  assert.equal(await verifyOAuthState(env, `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`), undefined);
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_JIRA_CLIENT_SECRET: "rotated" }, state), undefined);
  const expired = new URL(await oauthAuthorizeUrl(client, { spaceId: "s", userId: "u", redirectUri: "https://hub.test/cb",
    now: Date.now() - 11 * 60_000 })).searchParams.get("state");
  assert.equal(await verifyOAuthState(env, expired), undefined);
  assert.equal(await verifyOAuthState(env, "garbage"), undefined);
});

test("code exchange follows each provider's token request shape and records expiry", async () => {
  const linear = stubFetch([{ body: { access_token: "lin-token", refresh_token: "lin-refresh", expires_in: 3600 } },
    { body: { data: { organization: { id: "org-1" } } } }]);
  try {
    const fields = await exchangeOAuthCode(oauthClient(env, "linear"), "code-1", "https://hub.test/cb");
    assert.equal(linear.calls[0].headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(linear.calls[0].body, { grant_type: "authorization_code", code: "code-1",
      redirect_uri: "https://hub.test/cb", client_id: "lin-id", client_secret: "lin-secret" });
    assert.equal(fields.oauthToken, "lin-token");
    assert.equal(fields.oauthRefreshToken, "lin-refresh");
    assert.ok(Number(fields.oauthExpiresAt) > Date.now());
  } finally { linear.restore(); }

  const notion = stubFetch([{ body: { access_token: "secret_notion" } }]);
  try {
    const fields = await exchangeOAuthCode(oauthClient(env, "notion"), "code-2", "https://hub.test/cb");
    assert.equal(notion.calls[0].headers.get("authorization"), `Basic ${btoa("no-id:no-secret")}`);
    assert.deepEqual(notion.calls[0].body, { grant_type: "authorization_code", code: "code-2", redirect_uri: "https://hub.test/cb" });
    assert.deepEqual(fields, { integrationToken: "secret_notion", oauthRefreshToken: null, oauthExpiresAt: null });
  } finally { notion.restore(); }

  const jira = stubFetch([{ body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
    { body: [{ id: "cloud-1", url: "https://acme.atlassian.net" }] }]);
  try {
    const fields = await exchangeOAuthCode(oauthClient(env, "jira"), "code-3", "https://hub.test/cb");
    assert.equal(jira.calls[1].url, "https://api.atlassian.com/oauth/token/accessible-resources");
    assert.equal(fields.cloudId, "cloud-1");
    assert.equal(fields.siteUrl, "https://acme.atlassian.net");
  } finally { jira.restore(); }

  const refused = stubFetch([{ body: { error: "invalid_grant" } }]);
  try {
    await assert.rejects(exchangeOAuthCode(oauthClient(env, "linear"), "bad", "https://hub.test/cb"), /invalid_grant/u);
  } finally { refused.restore(); }
});

test("an OAuth token is refreshed only when it is about to expire", async () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  assert.equal(await refreshOAuthFields(env, "linear", { oauthToken: "t", oauthRefreshToken: "r",
    oauthExpiresAt: String(now + 3_600_000) }, now), undefined);
  assert.equal(await refreshOAuthFields(env, "linear", { oauthToken: "t" }, now), undefined);
  const refresh = stubFetch([{ body: { access_token: "t2", expires_in: 3600 } }]);
  try {
    const fields = await refreshOAuthFields(env, "linear", { oauthToken: "t", oauthRefreshToken: "r",
      oauthExpiresAt: String(now + 30_000) }, now);
    assert.deepEqual(refresh.calls[0].body, { grant_type: "refresh_token", refresh_token: "r",
      client_id: "lin-id", client_secret: "lin-secret" });
    assert.equal(fields.oauthToken, "t2");
    assert.equal("oauthRefreshToken" in fields, false, "a refresh that rotates nothing keeps the stored refresh token");
    assert.equal(fields.oauthExpiresAt, String(now + 3_600_000));
  } finally { refresh.restore(); }
  assert.deepEqual(oauthTokenFields(oauthClient(env, "notion"), { access_token: "x" }), { integrationToken: "x", oauthRefreshToken: null, oauthExpiresAt: null });
});

test("actions use an OAuth token when one is stored", async () => {
  const run = async (providerId, body, credentials, responses) => {
    const parsed = parseActionCommand(providerId, body);
    const action = connectorProvider(providerId).actions[parsed.actionId];
    const fetch = stubFetch(responses);
    try {
      await action.execute({ credentials }, action.parse(parsed.statement));
      return fetch.calls;
    } finally { fetch.restore(); }
  };
  const linear = await run("linear", "@linear:comment:ENG-1 hi", { oauthToken: "lt" },
    [{ body: { data: { commentCreate: { success: true } } } }]);
  assert.equal(linear[0].headers.get("authorization"), "Bearer lt");
  const gitlab = await run("gitlab", "@gitlab:comment:g/p!1 hi", { oauthToken: "gt" }, []);
  assert.equal(gitlab[0].headers.get("authorization"), "Bearer gt");
  assert.equal(gitlab[0].headers.get("private-token"), null);
  const jira = await run("jira", "@jira:comment:ENG-1 hi", { oauthToken: "jt", cloudId: "c1", siteUrl: "https://acme.atlassian.net" }, []);
  assert.equal(jira[0].url, "https://api.atlassian.com/ex/jira/c1/rest/api/3/issue/ENG-1/comment");
  assert.equal(jira[0].headers.get("authorization"), "Bearer jt");
});


test("Netlify's registered application exchanges a server-side code and verifies the issued token", async () => {
  const client = oauthClient({ CONNECTOR_NETLIFY_CLIENT_ID: "netlify-client", CONNECTOR_NETLIFY_CLIENT_SECRET: "netlify-secret" }, "netlify");
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space-netlify", userId: "admin", redirectUri: "https://hub.test/callback" }));
  assert.equal(url.origin + url.pathname, "https://app.netlify.com/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), null);
  const fetch = stubFetch([{ body: { access_token: "netlify-token" } }, { body: { id: "netlify-account" } }]);
  try {
    const fields = await exchangeOAuthCode(client, "netlify-code", "https://hub.test/callback");
    assert.equal(fields.oauthToken, "netlify-token");
    assert.equal(fetch.calls[0].url, "https://api.netlify.com/oauth/token");
    assert.deepEqual(fetch.calls[0].body, { grant_type: "authorization_code", code: "netlify-code", redirect_uri: "https://hub.test/callback", client_id: "netlify-client", client_secret: "netlify-secret" });
    await connectorProvider("netlify").verify(fields);
    assert.equal(fetch.calls[1].url, "https://api.netlify.com/api/v1/user");
    assert.equal(fetch.calls[1].headers.get("authorization"), "Bearer netlify-token");
  } finally { fetch.restore(); }
  for (const response of [{ status: 401, body: { error: "unauthorized" } }, { body: {} }]) {
    const invalid = stubFetch([response]);
    try { await assert.rejects(connectorProvider("netlify").verify({ oauthToken: "invalid-token" })); }
    finally { invalid.restore(); }
  }
  const webhookOnly = stubFetch([]);
  try {
    await connectorProvider("netlify").verify({ webhookSecret: "existing-jws-key" });
    assert.equal(webhookOnly.calls.length, 0, "webhook-only connections retain their existing setup");
  } finally { webhookOnly.restore(); }
});


test("Notion retains the provider token pair without inventing an expiry", async () => {
  const client = oauthClient(env, "notion");
  const fetch = stubFetch([{ body: { access_token: "notion-access", refresh_token: "notion-refresh" } }]);
  try {
    const fields = await exchangeOAuthCode(client, "code", "https://hub.test/cb");
    assert.deepEqual(fields, { integrationToken: "notion-access", oauthRefreshToken: "notion-refresh", oauthExpiresAt: null });
    const allowed = client.manifest.credentials.filter(field => field.managed).map(field => field.id);
    assert.ok(allowed.includes("oauthRefreshToken"));
    assert.ok(allowed.includes("oauthExpiresAt"));
    assert.equal(allowed.includes("integrationToken"), false, "manual integration tokens stay supported");
    assert.equal(await refreshOAuthFields(env, "notion", { integrationToken: "a", oauthRefreshToken: "r" }), undefined);
    assert.equal(fetch.calls.length, 1, "unknown expiry does not schedule an arbitrary refresh");
  } finally { fetch.restore(); }
});

test("Notion refresh rotates the access and refresh token together using Basic-auth JSON", async () => {
  const now = Date.now();
  const values = { integrationToken: "old-access", oauthRefreshToken: "old-refresh", oauthExpiresAt: String(now - 1) };
  const fetch = stubFetch([{ body: { access_token: "new-access", refresh_token: "new-refresh" } }]);
  try {
    const fields = await refreshOAuthFields(env, "notion", values, now);
    assert.equal(fetch.calls[0].url, "https://api.notion.com/v1/oauth/token");
    assert.equal(fetch.calls[0].headers.get("authorization"), `Basic ${btoa("no-id:no-secret")}`);
    assert.deepEqual(fetch.calls[0].body, { grant_type: "refresh_token", refresh_token: "old-refresh" });
    assert.deepEqual(fields, { integrationToken: "new-access", oauthRefreshToken: "new-refresh", oauthExpiresAt: null });
  } finally { fetch.restore(); }
  const missingPair = stubFetch([{ body: { access_token: "new-access" } }]);
  try { await assert.rejects(refreshOAuthFields(env, "notion", values, now), /rotated refresh token/); }
  finally { missingPair.restore(); }
});

test("disconnecting a Google connection forgets its tokens but keeps generated ingress secrets", () => {
  const tokens = { oauthToken: null, oauthRefreshToken: null, oauthExpiresAt: null };
  for (const id of ["google", "googlesearchconsole", "googleadsense", "gcp"]) {
    assert.deepEqual(grantFieldsForgottenOnDisconnect(id), tokens, id);
  }
  assert.equal(grantFieldsForgottenOnDisconnect("notion"), undefined);
  assert.equal(grantFieldsForgottenOnDisconnect("github"), undefined);
});

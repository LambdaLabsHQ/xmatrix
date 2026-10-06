import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, verifyOAuthState } from "../src/connectors/oauth.ts";
import { vercelApiUrl, vercelCompletionUrl, verifyVercel } from "../src/connectors/vercel-api.ts";
import { connectorProvider } from "../src/connectors/registry.ts";
import { sentryInstallationClient } from "../src/connectors/sentry-installation.ts";

const exchangeOAuthCode = async (...args) => (await exchangeOAuthGrant(...args)).fields;

const env = { CONNECTOR_VERCEL_CLIENT_ID: "oac_fixture", CONNECTOR_VERCEL_CLIENT_SECRET: "fixture-secret" };
const client = oauthClient(env, "vercel");
const configuration = { id: "icfg_fixture", integrationId: "oac_fixture", teamId: "team_fixture", userId: "user_fixture" };
const grant = { access_token: "fixture-token", installation_id: "icfg_fixture", team_id: "team_fixture", user_id: "user_fixture" };
function stubFetch(responses) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body, method: init.method ?? "GET" });
    const response = responses.shift();
    assert.ok(response, "unexpected provider request");
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("Vercel external install uses the registered slug and signed Space/admin state", async () => {
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space-vercel", userId: "admin", redirectUri: "https://hub.test/callback" }));
  assert.equal(url.origin + url.pathname, "https://vercel.com/integrations/xmatrix/new");
  assert.deepEqual([...url.searchParams.keys()], ["state"]);
  assert.ok(!url.toString().includes(env.CONNECTOR_VERCEL_CLIENT_SECRET));
  const state = url.searchParams.get("state");
  const verified = await verifyOAuthState(env, state);
  assert.equal(verified.spaceId, "space-vercel");
  assert.equal(verified.userId, "admin");
  assert.equal(verified.client.manifest.id, "vercel");
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_VERCEL_CLIENT_SECRET: "different" }, state), undefined);
  const expired = new URL(await oauthAuthorizeUrl(client, { spaceId: "s", userId: "u", redirectUri: "https://hub.test/callback", now: Date.now() - 11 * 60_000 }));
  assert.equal(await verifyOAuthState(env, expired.searchParams.get("state")), undefined);
});

test("Vercel code is exchanged server-side and the provider confirms configuration and team", async () => {
  const fetch = stubFetch([{ body: grant }, { body: configuration }]);
  try {
    const fields = await exchangeOAuthCode(client, "fixture-code", "https://hub.test/callback");
    assert.equal(fetch.calls[0].url, "https://api.vercel.com/v2/oauth/access_token");
    assert.equal(fetch.calls[0].headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(fetch.calls[0].body), { code: "fixture-code", redirect_uri: "https://hub.test/callback", client_id: "oac_fixture", client_secret: "fixture-secret" });
    assert.equal(fetch.calls[1].url, "https://api.vercel.com/v1/integrations/configuration/icfg_fixture?teamId=team_fixture");
    assert.equal(fetch.calls[1].headers.get("authorization"), "Bearer fixture-token");
    assert.equal(fields.oauthConfigurationId, "icfg_fixture");
    assert.equal(fields.oauthAppClientId, "oac_fixture");
    assert.equal(fields.oauthTeamId, "team_fixture");
    assert.equal(vercelCompletionUrl({ configurationId: "icfg_fixture", teamId: "team_fixture", next: "https://vercel.com/integrations/completed" }, fields), "https://vercel.com/integrations/completed");
    for (const input of [
      { configurationId: "icfg_other", teamId: "team_fixture", next: "https://vercel.com/done" },
      { configurationId: "icfg_fixture", teamId: "team_other", next: "https://vercel.com/done" },
      { configurationId: "icfg_fixture", next: "https://vercel.com/done" },
      ...["https://vercel.com.attacker.test/done", "http://vercel.com/done", "https://user:password@vercel.com/done", "https://attacker.test", "//vercel.com/done", ""].map(next => ({ configurationId: "icfg_fixture", teamId: "team_fixture", next })),
    ]) assert.equal(vercelCompletionUrl(input, fields), undefined);
  } finally { fetch.restore(); }
});

test("invalid scopes, other applications, disabled or removed configurations and refused tokens cannot connect", async () => {
  for (const invalid of [
    { ...grant, installation_id: "../../other" }, { ...grant, team_id: "team_bad&teamId=other" },
    { ...grant, team_id: undefined }, { ...grant, installation_id: undefined },
  ]) {
    const fetch = stubFetch([{ body: invalid }]);
    try { await assert.rejects(exchangeOAuthCode(client, "code", "https://hub.test/callback")); assert.equal(fetch.calls.length, 1); }
    finally { fetch.restore(); }
  }
  for (const response of [
    { body: { ...configuration, integrationId: "oac_other" } }, { body: { ...configuration, id: "icfg_other" } },
    { body: { ...configuration, disabledAt: 1 } }, { body: { ...configuration, deletedAt: 1 } },
    { body: { ...configuration, deleteRequestedAt: 1 } }, { status: 403, body: { error: "disabled" } },
    { body: { ...configuration, teamId: "team_other" } },
  ]) {
    const fetch = stubFetch([{ body: grant }, response]);
    try { await assert.rejects(exchangeOAuthCode(client, "code", "https://hub.test/callback")); }
    finally { fetch.restore(); }
  }
});

test("personal OAuth ignores stale manually supplied team scope and checks the installed application", async () => {
  const personal = { ...configuration, teamId: null };
  const fetch = stubFetch([{ body: { ...grant, team_id: null } }, { body: personal }, { body: personal }]);
  try {
    const fields = await exchangeOAuthCode(client, "code", "https://hub.test/callback");
    assert.equal(fields.oauthTeamId, null);
    assert.equal(fields.oauthUserId, "user_fixture");
    assert.equal(new URL(fetch.calls[1].url).searchParams.has("teamId"), false);
    await verifyVercel({ ...fields, teamId: "team_unrelated" });
    assert.equal(new URL(fetch.calls[2].url).searchParams.has("teamId"), false);
    assert.equal(vercelCompletionUrl({ configurationId: "icfg_fixture", next: "https://vercel.com/done" }, fields), "https://vercel.com/done");
  } finally { fetch.restore(); }
});

test("API-only Check validates a manual token while webhook-only setups retain their delivery path", async () => {
  assert.equal(connectorProvider("vercel").verify, verifyVercel);
  const fetch = stubFetch([{ body: { user: { uid: "user_fixture" } } }, { status: 401, body: { error: "unauthorized" } }]);
  try {
    await verifyVercel({ accessToken: "fixture-manual" });
    assert.equal(fetch.calls[0].url, "https://api.vercel.com/v2/user");
    await assert.rejects(verifyVercel({ accessToken: "fixture-invalid" }));
    await verifyVercel({ webhookSecret: "fixture-hook" });
    assert.equal(fetch.calls.length, 2);
  } finally { fetch.restore(); }
});

test("redeploy uses the OAuth token and its trusted team for both requests", async () => {
  const fetch = stubFetch([{ body: { name: "test-app", target: "production" } }, { body: { url: "test-app.vercel.app" } }]);
  try {
    const action = connectorProvider("vercel").actions.redeploy;
    assert.deepEqual(action.requires, ["accessToken|oauthToken"]);
    const result = await action.execute({ credentials: { oauthToken: "fixture-oauth", accessToken: "old-manual", oauthTeamId: "team_fixture", teamId: "team_unrelated" } }, { deployment: "dpl_fixture123" });
    for (const call of fetch.calls) {
      assert.equal(new URL(call.url).searchParams.get("teamId"), "team_fixture");
      assert.equal(call.headers.get("authorization"), "Bearer fixture-oauth");
    }
    assert.equal(fetch.calls[1].method, "POST");
    assert.equal(result.url, "https://test-app.vercel.app");
    assert.equal(vercelApiUrl({ accessToken: "manual", teamId: "team_manual" }, "v2/user").searchParams.get("teamId"), "team_manual");
  } finally { fetch.restore(); }
});

// Exercise the real callback handler with the authority/credential boundaries isolated.
test("the callback writes credentials only after verified state, provider scope and completion URL", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const ts = createRequire(import.meta.url)("typescript");
  const source = readFileSync(new URL("../src/index-routes-connector-oauth.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const fields = { oauthToken: "fixture-token", oauthConfigurationId: "icfg_fixture", oauthTeamId: "team_fixture" };
  let validState = true;
  let signedIn = "admin";
  let checkPasses = true;
  const effects = [];
  const exports = {};
  const dependencies = {
    "./connectors/sentry-installation": { sentryInstallationClient },
    "./connectors/teams-native": { teamsNativeApp: () => undefined },
    "./connectors/googlechat-native": { googleChatNativeApp: () => undefined },
    "./connectors/feishu-native": { feishuNativeApp: () => undefined },
    "./connectors/telegram-native": { telegramNativeApp: () => undefined },
    "./connectors/wecom-suite": { wecomNativeSuite: () => undefined },
    "./connectors/dingtalk-native": { dingtalkNativeCompany: () => undefined },
    "./app-connection-check": { checkAppConnection: async () => { effects.push("check"); return { ok: checkPasses }; } },
    "./app-connectors": { getAppConnectorProvider: () => client.manifest },
    "./connectors/credentials": { INGRESS_KEY_FIELD: "ingressKey", mintConnectorSecret: () => "fixture-ingress", connectorCredentialRepository: () => ({ put: async () => { effects.push("credentials"); } }) },
    "./connectors/oauth": {
      verifyOAuthState: async () => validState ? { client, spaceId: "space-vercel", userId: "admin" } : undefined,
      exchangeOAuthGrant: async () => { effects.push("exchange"); return { fields }; },
      oauthRedirectUri: origin => `${origin}/api/connectors/oauth/callback`,
    },
    "./connectors/vercel-api": { vercelCompletionUrl },
    "./deployment-origins": { appOrigin: () => "https://xmatrix.test" },
    "./index-shared": { connectorHubOrigin: () => "https://hub.test", requireAuth: async () => ({}),
      requireHumanAuth: () => ({ id: signedIn }), jsonErrors: async (_context, run) => run() },
    "@xmatrix/protocol": { HUB_ROUTES: { connector_oauth_complete: "/api/connectors/oauth/complete" } },
    "@xmatrix/db": { ControlError: class ControlError extends Error {} },
    "./apps": { upsertAppConnection: async () => { effects.push("connection"); return {}; } },
  };
  runInNewContext(code, { exports, require: name => { assert.ok(dependencies[name], name); return dependencies[name]; }, crypto, URL, console });
  let complete;
  exports.registerConnectorOAuthRoutes({ get() {}, post(path, handler) { if (path === "/api/connectors/oauth/complete") complete = handler; } });
  const invoke = async overrides => {
    effects.length = 0;
    const body = { state: "fixture-state", code: "code", configurationId: "icfg_fixture", teamId: "team_fixture", next: "https://vercel.com/integrations/done", ...overrides };
    const result = await complete({ env: {}, req: { raw: new Request("https://hub.test/api/connectors/oauth/complete"), json: async () => body },
      json: (payload, status) => ({ body: payload, status }) });
    return { url: result.body?.redirect, status: result.status, effects: [...effects] };
  };
  validState = false;
  assert.deepEqual((await invoke({})).effects, []);
  validState = true;
  for (const tampered of [{ configurationId: "icfg_other" }, { teamId: "team_other" }, { next: "https://attacker.test" }]) {
    const result = await invoke(tampered);
    assert.deepEqual(result.effects, ["exchange"]);
    assert.match(result.url, /oauth=failed/);
  }
  const successful = await invoke({});
  assert.deepEqual(successful.effects, ["exchange", "connection", "credentials", "check"]);
  assert.equal(successful.url, "https://vercel.com/integrations/done");
  signedIn = "someone-else";
  const foreign = await invoke({});
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.effects, []);
  signedIn = "admin";
  checkPasses = false;
  assert.match((await invoke({})).url, /oauth=failed/);
});

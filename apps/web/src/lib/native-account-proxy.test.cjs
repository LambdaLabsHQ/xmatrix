const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { nativeAccountCall } = require("./native-account-proxy.ts");

test("an app page's session reaches only its own account calls, nothing else on the Hub's auth surface", () => {
  for (const allowed of [["get-session"], ["two-factor", "verify-totp"], ["list-accounts"], ["link-social"],
    ["unlink-account"], ["sign-out"], ["oauth2", "get-consents"], ["oauth2", "delete-consent"]]) {
    const path = allowed.join("/");
    const method = ["get-session", "list-accounts", "oauth2/get-consents"].includes(path) ? "GET" : "POST";
    assert.equal(nativeAccountCall(allowed, method)?.path, path);
  }
  for (const refused of [["token"], ["revoke-sessions"], ["sign-in", "email"], ["passkey", "generate-register-options"],
    ["admin", "list-users"], ["two-factor", "..", "token"], ["oauth2", "authorize"], []]) {
    assert.equal(nativeAccountCall(refused, "GET"), null, refused.join("/"));
  }
});

// Exercise the actual Next route with its request cookie store. The upstream
// responses are fixtures; credential filtering and cookie adoption are production.
globalThis.AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external");
const { RequestCookies } = require("next/dist/compiled/@edge-runtime/cookies");
const accountRoute = require("../app/api/xmatrix/native-auth/[...path]/route.ts");
const { NATIVE_REFRESH_COOKIE, NATIVE_ACCESS_COOKIE } = require("./native-session.ts");

const APP = "https://app.native.test";
const SESSION_TOKEN = "fixture-long-lived-session";
async function accountCall(t, path, upstream, { method = "GET", origin = APP, cookie = SESSION_TOKEN } = {}) {
  const headers = new Headers({ cookie: `${NATIVE_REFRESH_COOKIE}=${cookie}` });
  if (origin) headers.set("origin", origin);
  t.mock.method(globalThis, "fetch", async (target, init) => {
    assert.equal(new URL(target).pathname, `/api/auth/${path}`);
    assert.equal(init.headers.authorization, `Bearer ${cookie}`);
    return upstream;
  });
  const request = new Request(`${APP}/api/xmatrix/native-auth/${path}`, { method, headers });
  return workAsyncStorage.run({ route: "/api/xmatrix/native-auth/[...path]" }, () => workUnitAsyncStorage.run({ type: "request", phase: "render", cookies: new RequestCookies(headers) },
    () => accountRoute[method](request, { params: Promise.resolve({ path: path.split("/") }) })));
}

test("native account reads expose account facts without exposing the session credential", async (t) => {
  const response = await accountCall(t, "get-session", Response.json({
    session: { id: "session-id", token: SESSION_TOKEN, expiresAt: "2026-11-18T00:00:00Z" },
    user: { id: "user-id", email: "person@example.test", twoFactorEnabled: true },
  }, { headers: { "set-auth-token": SESSION_TOKEN } }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.user.twoFactorEnabled, true, "the account settings still read their state");
  assert.equal(payload.session.id, "session-id");
  assert.equal(payload.session.token, undefined);
  assert.equal(response.headers.get("set-auth-token"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("native two-factor confirmation keeps its replacement session in cookies only", async (t) => {
  const replacement = "replacement-session";
  const signed = encodeURIComponent(`${replacement}.upstream-signature`);
  const response = await accountCall(t, "two-factor/verify-totp", Response.json({
    token: SESSION_TOKEN, user: { id: "user-id", twoFactorEnabled: true },
  }, { headers: { "set-auth-token": signed, "set-cookie": "better-auth.session_token=upstream-session; HttpOnly; Secure; Path=/" } }),
  { method: "POST" });
  const payload = await response.json();
  assert.equal(payload.user.id, "user-id");
  assert.equal(payload.token, undefined);
  const cookies = response.headers.getSetCookie().join("; ");
  assert.doesNotMatch(cookies, /better-auth.session_token/);
  assert.equal(response.cookies.get(NATIVE_REFRESH_COOKIE).value, replacement);
  assert.equal(response.cookies.get(NATIVE_REFRESH_COOKIE).httpOnly, true);
  assert.equal(response.cookies.get(NATIVE_REFRESH_COOKIE).secure, true);
  assert.match(cookies, new RegExp(`${NATIVE_ACCESS_COOKIE}=;`), "the old access token is refreshed next load");
  assert.equal(response.headers.get("set-auth-token"), null);
});

test("a native replacement session refreshes on the next load without returning its credential", async (t) => {
  const { GET } = require("../app/api/xmatrix/native-session/route.ts");
  t.mock.method(globalThis, "fetch", async (_target, init) => {
    assert.equal(JSON.parse(init.body).refreshToken, SESSION_TOKEN);
    return Response.json({ token: "new-access", refreshToken: SESSION_TOKEN, user: { id: "user-id" },
      authProvider: "better-auth", hubUrl: "https://hub.native.test", relayUrl: "wss://hub.native.test" });
  });
  const response = await GET(new Request(`${APP}/api/xmatrix/native-session`, {
    headers: { cookie: `${NATIVE_REFRESH_COOKIE}=${SESSION_TOKEN}` },
  }));
  const payload = await response.json();
  assert.equal(payload.session.token, "new-access");
  assert.equal(payload.session.refreshToken, undefined);
  assert.equal(response.cookies.get(NATIVE_REFRESH_COOKIE).value, SESSION_TOKEN);
});

test("native account capabilities preserve setup, lists and refusals while dropping unlisted fields", async (t) => {
  for (const [path, method, body, expected] of [
    ["two-factor/enable", "POST", { totpURI: "otpauth://fixture", backupCodes: ["backup"], token: SESSION_TOKEN },
      { totpURI: "otpauth://fixture", backupCodes: ["backup"] }],
    ["list-accounts", "GET", [{ id: "account", providerId: "github", accountId: "provider-id", accessToken: SESSION_TOKEN }],
      [{ id: "account", providerId: "github", accountId: "provider-id" }]],
    ["oauth2/get-consents", "GET", [{ id: "consent", clientId: "app", scopes: ["read"], secret: SESSION_TOKEN }],
      [{ id: "consent", clientId: "app", scopes: ["read"] }]],
    ["link-social", "POST", { url: "https://github.com/login/oauth/authorize?state=fixture", redirect: true, token: SESSION_TOKEN },
      { url: "https://github.com/login/oauth/authorize?state=fixture", redirect: true }],
    ["sign-out", "POST", { success: true, futureField: SESSION_TOKEN }, { success: true }],
    ["get-session", "GET", null, null],
  ]) {
    await t.test(path + (body === null ? " signed out" : ""), async (st) => {
      const response = await accountCall(st, path, Response.json(body), { method });
      assert.deepEqual(await response.json(), expected);
    });
  }
  await t.test("refusal", async (st) => {
    const response = await accountCall(st, "two-factor/enable",
      Response.json({ code: "INVALID_PASSWORD", message: "Confirm with your password", token: SESSION_TOKEN }, { status: 400 }),
      { method: "POST" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: "INVALID_PASSWORD", message: "Confirm with your password" });
  });
});

test("foreign writes, wrong methods and unlisted calls never forward the native credential", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("refused before the credential reaches upstream"));
  for (const [path, method, origin, status] of [
    ["sign-out", "POST", "https://foreign.test", 403], ["sign-out", "POST", "", 403],
    ["sign-out", "GET", APP, 404], ["two-factor/new-provider-endpoint", "POST", APP, 404],
    ["token", "GET", APP, 404], ["constructor", "GET", APP, 404],
  ]) {
    const response = await accountRoute[method](new Request(`${APP}/api/xmatrix/native-auth/${path}`,
      { method, headers: origin ? { origin } : {} }), { params: Promise.resolve({ path: path.split("/") }) });
    assert.equal(response.status, status, path);
  }
});

test("linking a provider carries its state cookie without handing the browser a raw Hub session", async (t) => {
  const upstream = Response.json({ url: "https://github.com/login/oauth/authorize?state=fixture", redirect: true });
  for (const cookie of ["__Secure-xmatrix-auth.state=bound; HttpOnly; Secure; Path=/; Domain=.native.test",
    "__Secure-xmatrix-auth.session_token=long-lived; HttpOnly; Secure; Path=/; Domain=.native.test",
    "__Secure-xmatrix-auth.session_data=cached; HttpOnly; Secure; Path=/; Domain=.native.test"]) {
    upstream.headers.append("set-cookie", cookie);
  }
  const response = await accountCall(t, "link-social", upstream, { method: "POST" });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^__Secure-xmatrix-auth.state=bound;/);
});

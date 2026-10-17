import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeOAuthGrant, grantFieldsForgottenOnDisconnect, oauthAuthorizeUrl, oauthClient, verifyOAuthState } from "../src/connectors/oauth.ts";
import { parseXAccounts, xAccountFields } from "../src/connectors/x-accounts.ts";
import { xOAuthFields, xTokenGrant } from "../src/connectors/x-oauth.ts";
import { withProviderResponses } from "./support/fetch-responses.mjs";

const env = { CONNECTOR_X_CLIENT_ID: "x-company-client", CONNECTOR_X_CLIENT_SECRET: "private-client-secret" };
const redirectUri = "https://hub.test/api/connectors/oauth/callback";
const snapshot = { connectionVersion: 1, credentialVersion: 0, connectionGeneration: "initial-connection-generation" };
const scopes = "tweet.read users.read tweet.write media.write offline.access";
const client = oauthClient(env, "x");
const token = extra => ({ access_token: "private-access-token", refresh_token: "private-refresh-token",
  token_type: "bearer", expires_in: 7200, scope: scopes, ...extra });
const account = extra => ({ id: "101", username: "company", generation: "cf2b16cd-b6b0-4e9d-8b00-f4f1ec2bcbd2", ownerUserId: "human-owner",
  clientId: env.CONNECTOR_X_CLIENT_ID, accessToken: "private-access-token", refreshToken: "private-refresh-token",
  expiresAt: Date.now() + 7_200_000, scopes, ...extra });
const start = extra => oauthAuthorizeUrl(client, { spaceId: "selected-space", userId: "human-owner", redirectUri, connectionSnapshot: snapshot, ...extra });
const startState = async extra => new URL(await start(extra)).searchParams.get("state");

test("X OAuth requests a narrow offline PKCE grant and signs the Space, Human, client and connection snapshot", async () => {
  assert.equal(oauthClient({}, "x"), undefined);
  assert.equal(oauthClient({ CONNECTOR_X_CLIENT_ID: "id" }, "x"), undefined);
  const url = new URL(await start());
  assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), env.CONNECTOR_X_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.deepEqual(url.searchParams.get("scope").split(" ").sort(), scopes.split(" ").sort());
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.ok(!url.toString().includes(env.CONNECTOR_X_CLIENT_SECRET));
  const state = url.searchParams.get("state");
  const verified = await verifyOAuthState(env, state);
  assert.equal(verified.client.manifest.id, "x");
  assert.equal(verified.spaceId, "selected-space");
  assert.equal(verified.userId, "human-owner");
  assert.deepEqual(verified.connectionSnapshot, snapshot);
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_X_CLIENT_ID: "other-client" }, state), undefined);
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_X_CLIENT_SECRET: "rotated-secret" }, state), undefined);
  assert.equal(await verifyOAuthState(env, await startState({ now: Date.now() - 660_000 })), undefined);
});

test("X OAuth state rejects tampering and missing or malformed connection snapshots", async () => {
  const state = await startState();
  const [body, signature] = state.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  for (const [field, value] of [["providerId", "google"], ["spaceId", "other-space"], ["userId", "other-human"],
    ["clientId", "other-client"], ["redirectUri", "https://evil.test/callback"], ["connectionSnapshot", { ...snapshot, credentialVersion: 1 }]]) {
    const tampered = `${Buffer.from(JSON.stringify({ ...claims, [field]: value })).toString("base64url")}.${signature}`;
    assert.equal(await verifyOAuthState(env, tampered), undefined, field);
  }
  for (const connectionSnapshot of [undefined, { ...snapshot, connectionVersion: 0 }, { ...snapshot, credentialVersion: -1 },
    { ...snapshot, credentialVersion: 0.5 }, { ...snapshot, connectionGeneration: "" }]) {
    assert.equal(await verifyOAuthState(env, await startState({ connectionSnapshot })), undefined);
  }
  assert.equal(await verifyOAuthState(env, await startState({ accountId: "0" })), undefined);
  assert.equal(await verifyOAuthState(env, "bad-state"), undefined);
  assert.equal(await verifyOAuthState(env, "x".repeat(4097)), undefined);
});

test("X code exchange proves PKCE and authenticates /users/me before producing an account grant", async () => {
  const url = new URL(await start());
  const before = Date.now();
  const { result, calls } = await withProviderResponses([{ body: token() }, { body: { data: { id: "101", username: "company", name: "unneeded-provider-profile" } } }],
    () => exchangeOAuthGrant(client, "one-time-code", redirectUri, url.searchParams.get("state")));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.x.com/2/oauth2/token");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("authorization"), `Basic ${btoa(`${env.CONNECTOR_X_CLIENT_ID}:${env.CONNECTOR_X_CLIENT_SECRET}`)}`);
  assert.equal(calls[0].headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(calls[0].body.grant_type, "authorization_code");
  assert.equal(calls[0].body.code, "one-time-code");
  assert.equal(calls[0].body.redirect_uri, redirectUri);
  assert.match(calls[0].body.code_verifier, /^[A-Za-z0-9_-]{43}$/u);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(calls[0].body.code_verifier))).toString("base64url");
  assert.equal(challenge, url.searchParams.get("code_challenge"));
  assert.equal(Object.hasOwn(calls[0].body, "client_secret"), false);
  assert.equal(calls[1].url, "https://api.x.com/2/users/me");
  assert.equal(calls[1].headers.get("authorization"), "Bearer private-access-token");
  const [connected] = parseXAccounts(result.fields.accounts);
  assert.equal(connected.id, "101"); assert.equal(connected.username, "company");
  assert.equal(connected.ownerUserId, "human-owner"); assert.equal(connected.clientId, env.CONNECTOR_X_CLIENT_ID);
  assert.equal(connected.accessToken, "private-access-token"); assert.equal(connected.refreshToken, "private-refresh-token");
  assert.match(connected.generation, /^[a-f0-9-]{36}$/u);
  assert.ok(connected.expiresAt >= before + 7_200_000 && connected.expiresAt <= Date.now() + 7_200_000);
  assert.doesNotMatch(JSON.stringify(result), /unneeded-provider-profile|private-client-secret/u);
});

test("X exchange refuses missing state, a changed client or a substituted callback before provider I/O", async () => {
  const state = await startState();
  for (const [exchangeClient, callback, proof] of [[client, redirectUri, undefined], [client, "https://evil.test/callback", state],
    [{ ...client, clientId: "other-client" }, redirectUri, state]]) {
    const { calls } = await withProviderResponses([], async () => {
      await assert.rejects(exchangeOAuthGrant(exchangeClient, "code", callback, proof), /OAuth proof/u);
    });
    assert.equal(calls.length, 0);
  }
});

test("X grants demand complete minimal scopes, refresh token, Bearer type and bounded expiry", () => {
  const before = Date.now();
  const fields = xTokenGrant(client, token());
  assert.equal(fields.scopes, scopes);
  assert.ok(fields.expiresAt >= before + 7_200_000 && fields.expiresAt <= Date.now() + 7_200_000);
  for (const extra of [{ access_token: "" }, { access_token: "secret\nline" }, { refresh_token: undefined }, { refresh_token: "" },
    { token_type: "Basic" }, { expires_in: 0 }, { expires_in: 86_401 }, { expires_in: "7200" }, { expires_in: 1.5 },
    { scope: undefined }, { scope: "tweet.read users.read tweet.write media.write" }, { scope: scopes + " dm.write" },
    { scope: scopes + " tweet.read" }]) {
    assert.throws(() => xTokenGrant(client, token(extra)), error => error.status === 502 &&
      !/private-access-token|private-refresh-token|private-client-secret|secret\nline/u.test(error.message));
  }
  const refreshed = xTokenGrant(client, token({ scope: undefined, access_token: "rotated-access", refresh_token: "rotated-refresh" }), account());
  assert.equal(refreshed.refreshToken, "rotated-refresh");
  assert.equal(refreshed.scopes, scopes);
  assert.throws(() => xTokenGrant(client, token({ scope: undefined, refresh_token: undefined }), account()), /complete offline grant/u);
});

test("X verifies the authenticated account identity and keeps rejected provider responses out of errors", async () => {
  for (const data of [{ id: "0", username: "company" }, { id: "101", username: "bad/handle" }, { id: "101" }, {}, null]) {
    await withProviderResponses([{ body: { data } }], () => assert.rejects(xOAuthFields(client, token(), "human-owner"), /connected account/u));
  }
  const reconnectState = await startState({ accountId: "101" });
  const { calls } = await withProviderResponses([{ body: token() }, { body: { data: { id: "202", username: "personal" } } }],
    () => assert.rejects(exchangeOAuthGrant(client, "code", redirectUri, reconnectState), /different X account/u));
  assert.equal(calls.length, 2, "the signed reconnect identity must survive code exchange and /users/me verification");
  const state = await startState();
  for (const replies of [[{ status: 400, body: { error: "private-access-token private-client-secret private-refresh-token" } }],
    [{ body: token() }, { status: 401, body: { message: "private-access-token private-client-secret private-refresh-token" } }]]) {
    await withProviderResponses(replies, () => assert.rejects(exchangeOAuthGrant(client, "code", redirectUri, state), error =>
      !/private-access-token|private-client-secret|private-refresh-token/u.test(error.message)));
  }
});

test("X encrypted account lists fail closed on duplicate identities, malformed grants and oversized data", () => {
  assert.deepEqual(parseXAccounts(undefined), []);
  assert.deepEqual(parseXAccounts("[]"), []);
  const original = account();
  assert.deepEqual(parseXAccounts(xAccountFields([original]).accounts), [original]);
  assert.deepEqual(xAccountFields([]), { accounts: null });
  assert.deepEqual(grantFieldsForgottenOnDisconnect("x"), { accounts: null });
  for (const value of ["not-json", "{}", JSON.stringify([original, original]),
    JSON.stringify([account({ id: "0" })]), JSON.stringify([account({ username: "bad/handle" })]),
    JSON.stringify([account({ generation: "not-a-generation" })]), JSON.stringify([account({ ownerUserId: "other/user" })]),
    JSON.stringify([account({ accessToken: "private-access-token\nsecret" })]), JSON.stringify([account({ refreshToken: "x".repeat(2049) })]),
    JSON.stringify([account({ expiresAt: 0 })]), JSON.stringify([account({ refreshing: crypto.randomUUID() })]),
    JSON.stringify([account({ extra: "界".repeat(90_000) })])]) {
    assert.throws(() => parseXAccounts(value), error => error.status === 409 && !/private-access-token|private-refresh-token/u.test(error.message));
  }  const many = Array.from({ length: 12 }, (_, i) => account({ id: String(i + 1) }));
  assert.equal(parseXAccounts(xAccountFields(many).accounts).length, 12, "accounts are not counted");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { googleChatAppClient, verifyGoogleChatAddonRequest } from "../src/connectors/googlechat-app-auth.ts";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const endpoint = "https://hub.example/api/connectors/googlechat/events";
const systemEmail = "service-218762573462@gcp-sa-gsuiteaddons.iam.gserviceaccount.com";
const appEmail = "xmatrix-googlechat@made-by-robot-xmatrix.iam.gserviceaccount.com";
const settings = { endpoint, systemServiceAccountEmail: systemEmail };
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const googleKeys = "https://www.googleapis.com/oauth2/v3/certs";
const scope = "https://www.googleapis.com/auth/chat.bot";
const space = "spaces/AAAA-fixture";
const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...await exportJWK(publicKey), kid: "fixture-google-key", alg: "RS256", use: "sig" };
const account = { type: "service_account", project_id: "made-by-robot-xmatrix", client_email: appEmail,
  private_key_id: "a".repeat(40), private_key: await exportPKCS8(privateKey), token_uri: tokenEndpoint,
  universe_domain: "googleapis.com", auth_uri: "https://unused.example/authorize" };
const grant = { access_token: "fixture-server-only-access", token_type: "Bearer", expires_in: 3600 };
const client = () => googleChatAppClient(JSON.stringify(account));

async function withProvider(responses, operation, options) {
  const stub = stubFetchResponses(responses, options);
  try { return { value: await operation(), calls: stub.calls }; }
  finally { stub.restore(); }
}

async function idToken(changes = {}, signingKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: "https://accounts.google.com", aud: endpoint, sub: "123456789012345678901",
    iat: now, exp: now + 3600, email: systemEmail, email_verified: true, ...changes })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid, jku: "https://attacker.example/keys" }).sign(signingKey);
}

const request = token => new Request("https://spoofed.example/api/connectors/googlechat/events", {
  method: "POST", headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  body: JSON.stringify({ authorizationEventObject: { systemIdToken: "untrusted-body-token" },
    claimedIssuer: appEmail, spaceId: "untrusted-space" }),
});
const denied = error => error.status === 401 && error.message === "Google Chat request authentication failed";

test("Chat API uses one server-owned RS256 assertion and only chat.bot without impersonation", async () => {
  const run = await withProvider([{ body: grant }, { body: { name: space, spaceType: "SPACE", displayName: "E2E" } }],
    () => client().getSpace(space));
  assert.deepEqual(run.value, { name: space, displayName: "E2E" });
  assert.equal(run.calls[0].url, tokenEndpoint);
  assert.equal(run.calls[0].method, "POST");
  assert.equal(run.calls[0].headers.get("content-type"), "application/x-www-form-urlencoded");
  const form = Object.fromEntries(run.calls[0].body);
  assert.equal(form.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const { payload, protectedHeader } = await jwtVerify(form.assertion, publicKey,
    { issuer: appEmail, audience: tokenEndpoint, algorithms: ["RS256"] });
  assert.equal(protectedHeader.kid, account.private_key_id);
  assert.equal(payload.scope, scope);
  assert.equal(payload.sub, undefined);
  assert.equal(payload.exp - payload.iat, 3600);
  assert.equal(run.calls[1].url, `https://chat.googleapis.com/v1/${space}`);
  assert.equal(run.calls[1].headers.get("authorization"), `Bearer ${grant.access_token}`);
  assert.doesNotMatch(JSON.stringify(run.value), /access|PRIVATE KEY|serviceAccount/);
});

test("service-account parsing rejects unrelated credentials, foreign token endpoints and malformed keys without requests", () => {
  const invalid = [{ type: "authorized_user" }, { project_id: "another-project" }, { client_email: systemEmail },
    { token_uri: "https://attacker.example/token" }, { universe_domain: "attacker.example" },
    { private_key_id: "unsafe-key-id" }, { private_key: "fixture-private-material" }];
  for (const change of invalid) {
    assert.throws(() => googleChatAppClient(JSON.stringify({ ...account, ...change })),
      error => error.status === 503 && !error.message.includes("fixture-private-material"));
  }
  for (const value of ["bad-json", "null", "[]", " ".repeat(16385)]) {
    assert.throws(() => googleChatAppClient(value), /not configured/);
  }
});

test("space addresses and text bounds fail before minting any app token", async () => {
  const stub = stubFetchResponses([]);
  try {
    for (const bad of ["https://attacker.example/space", "spaces/../other", "spaces/AAAA/messages/X", "spaces/AAAA?user=other", "spaces/AAAA#x"]) {
      await assert.rejects(client().getSpace(bad), /explicit Google Chat space/);
      await assert.rejects(client().postMessage(bad, "test"), /explicit Google Chat space/);
    }
    for (const text of ["", "   ", "x".repeat(4001), "界".repeat(1334), "private\u0000text"]) {
      await assert.rejects(client().postMessage(space, text), /up to 4000 bytes/);
    }
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test("empty, broad, long-lived or malformed app grants never reach the Chat API", async () => {
  for (const change of [{ access_token: "" }, { access_token: "token\r\nprivate" }, { token_type: "Basic" },
    { expires_in: "3600" }, { expires_in: 3601 }, { expires_in: 0 }, { expires_in: true },
    { scope: scope + " https://www.googleapis.com/auth/drive" }]) {
    const stub = stubFetchResponses([{ body: { ...grant, ...change } }]);
    try {
      await assert.rejects(client().getSpace(space), error => error.status === 503 && /could not be confirmed/.test(error.message));
      assert.equal(stub.calls.length, 1);
    } finally { stub.restore(); }
  }
  const stub = stubFetchResponses([{ status: 302, body: { error: "fixture-private-error" } }]);
  try {
    await assert.rejects(client().getSpace(space), error => error.status === 503 && !error.message.includes("fixture-private-error"));
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test("selected-space identity is provider-confirmed and never returned from a mismatched receipt", async () => {
  for (const response of [{ name: "spaces/OTHER", spaceType: "SPACE" }, { name: space, spaceType: "UNKNOWN" }, {}]) {
    await assert.rejects(withProvider([{ body: grant }, { body: response }], () => client().getSpace(space)), /selected space/);
  }
});

test("posting sends a single bounded text request and exposes only a matching message identity", async () => {
  const name = `${space}/messages/message.fixture`;
  const run = await withProvider([{ body: grant }, { body: { name, sender: { email: "private@example.com" } } }],
    () => client().postMessage(space, "hello\nsecond line"));
  assert.deepEqual(run.value, { name });
  assert.equal(run.calls[1].method, "POST");
  assert.equal(run.calls[1].url, `https://chat.googleapis.com/v1/${space}/messages`);
  assert.deepEqual(JSON.parse(run.calls[1].body), { text: "hello\nsecond line" });
  for (const response of [{}, { name: "spaces/OTHER/messages/m" }, { name: `${space}/messages/m/../other` }]) {
    const stub = stubFetchResponses([{ body: grant }, { body: response }]);
    try {
      await assert.rejects(client().postMessage(space, "one write"), /check the space before retrying/);
      assert.equal(stub.calls.length, 2, "an ambiguous receipt must not cause another write");
    } finally { stub.restore(); }
  }
});

test("add-on request verification trusts the fixed Google keys and exact system account, independently of Host/body", async () => {
  for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
    const run = await withProvider([{ body: { keys: [jwk] } }],
      async () => verifyGoogleChatAddonRequest(request(await idToken({ iss })), settings));
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].url, googleKeys);
    assert.equal(run.calls[0].headers.get("authorization"), null);
  }
});

test("forged, expired, wrong-issuer/account/audience and broad audience tokens fail without disclosing claims", async () => {
  const now = Math.floor(Date.now() / 1000);
  const changes = [{ iss: "https://attacker.example" }, { email: appEmail }, { email_verified: false },
    { email_verified: "true" }, { aud: "https://spoofed.example/api/connectors/googlechat/events" },
    { aud: [endpoint, "https://other.example"] }, { sub: "" }, { sub: undefined }, { iat: now + 120, exp: now + 3600 },
    { iat: now - 7200, exp: now - 3600 }, { exp: now + 7200 }, { exp: undefined }, { iat: now + 0.5 }];
  for (const change of changes) {
    await assert.rejects(withProvider([{ body: { keys: [jwk] } }],
      async () => verifyGoogleChatAddonRequest(request(await idToken(change)), settings)), denied);
  }
  const other = await generateKeyPair("RS256");
  await assert.rejects(withProvider([{ body: { keys: [jwk] } }],
    async () => verifyGoogleChatAddonRequest(request(await idToken({}, other.privateKey)), settings)), denied);
});

test("missing or malformed bearer, unsupported algorithm and absent key ids never fetch verification keys", async () => {
  const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("fixture-only-hmac-material"));
  const noKid = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).sign(privateKey);
  const stub = stubFetchResponses([]);
  try {
    for (const value of [undefined, "bad", "a.b.c", token, noKid]) {
      await assert.rejects(verifyGoogleChatAddonRequest(request(value), settings), denied);
    }
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test("invalid deployment identity and unavailable or oversized key sets fail closed", async () => {
  const stub = stubFetchResponses([]);
  try {
    for (const change of [{ endpoint: "http://hub.example/api/connectors/googlechat/events" },
      { endpoint: endpoint + "?aud=other" }, { endpoint: "https://hub.example/other" },
      { systemServiceAccountEmail: "chat@system.gserviceaccount.com" }]) {
      await assert.rejects(verifyGoogleChatAddonRequest(request(), { ...settings, ...change }), error => error.status === 503);
    }
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
  for (const response of [{ status: 503, body: { error: "private-provider-error" } },
    { body: { keys: [] } }, { body: { keys: Array(33).fill(jwk) } }]) {
    await assert.rejects(withProvider([response], async () => verifyGoogleChatAddonRequest(request(await idToken()), settings)),
      error => error.status === 503 && error.message === "Google Chat verification keys are unavailable");
  }
});

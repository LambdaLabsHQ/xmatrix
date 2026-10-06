import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyTeamsRequest, teamsBotClient } from "../src/connectors/teams-api.ts";
import { teamsServiceUrl } from "@xmatrix/db";
import { stubFetchResponses } from "./support/fetch-responses.mjs";
import { teamsApp, teamsReference as reference } from "./support/teams-fixture.mjs";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "fixture-key", endorsements: ["msteams"] };
const metadata = { issuer: "https://api.botframework.com", jwks_uri: "https://login.botframework.com/v1/.well-known/keys", id_token_signing_alg_values_supported: ["RS256"] };
const grant = { access_token: "fixture-token", token_type: "Bearer", expires_in: 3600 };
const member = { id: reference.userId, objectId: reference.userObjectId, tenantId: teamsApp.tenantId };
async function token(changes = {}, key = privateKey, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: metadata.issuer, aud: teamsApp.appId, nbf: now - 10, exp: now + 3600,
    serviceurl: reference.serviceUrl, ...changes }).setProtectedHeader({ alg: "RS256", kid: jwk.kid,
    jku: "https://attacker.invalid/keys", ...header }).sign(key);
}
const request = value => new Request("https://spoofed.invalid/events", { headers: { authorization: `Bearer ${value}` } });
async function run(responses, operation) {
  const stub = stubFetchResponses(responses);
  try { return { value: await operation(), calls: stub.calls }; } finally { stub.restore(); }
}
const verify = async value => verifyTeamsRequest(request(value), teamsApp, reference.serviceUrl);

test("Teams JWT uses fixed metadata and keys, RS256, audience, issuer, clock, serviceurl and channel endorsements", async () => {
  const result = await run([{ body: metadata }, { body: { keys: [jwk] } }], () => token().then(verify));
  assert.deepEqual(result.calls.map(call => call.url), ["https://login.botframework.com/v1/.well-known/openidconfiguration", metadata.jwks_uri]);
  const now = Math.floor(Date.now() / 1000);
  for (const changes of [{ aud: "wrong" }, { aud: [teamsApp.appId, "wrong"] }, { iss: "https://login.microsoftonline.com/tenant" },
    { exp: now - 301 }, { nbf: now + 600 }, { serviceurl: "https://smba.trafficmanager.net/emea/" },
    { serviceurl: undefined }, { serviceUrl: reference.serviceUrl + "other" }]) {
    await run([{ body: metadata }, { body: { keys: [jwk] } }], async () => {
      await assert.rejects(verify(await token(changes)), error => error.status === 401);
    });
  }
  for (const keys of [[{ ...jwk, endorsements: ["directline"] }], [jwk, jwk], []]) {
    await run([{ body: metadata }, { body: { keys } }], async () => assert.rejects(verify(await token())));
  }
});

test("Teams signature forgery, missing auth and spoofed service URL fail before any authority access", async () => {
  const other = await generateKeyPair("RS256");
  await run([{ body: metadata }, { body: { keys: [jwk] } }], async () => assert.rejects(verify(await token({}, other.privateKey)), error => error.status === 401));
  const invalid = await run([], async () => {
    for (const url of ["https://attacker.invalid/amer/", "https://smba.trafficmanager.net.attacker.invalid/amer/", "https://smba.trafficmanager.net/amer/?secret=x",
      "https://user@smba.trafficmanager.net/amer/", "http://smba.trafficmanager.net/amer/", "https://smba.trafficmanager.net/../amer/", "https://smba.trafficmanager.net:444/amer/"]) {
      assert.throws(() => teamsServiceUrl(url));
      await assert.rejects(verifyTeamsRequest(request(await token()), teamsApp, url), error => error.status === 401);
    }
    await assert.rejects(verifyTeamsRequest(new Request("https://hub.invalid"), teamsApp, reference.serviceUrl), error => error.status === 401);
  });
  assert.equal(invalid.calls.length, 0);
  await run([{ body: { ...metadata, jwks_uri: "https://attacker.invalid/keys" } }], async () => assert.rejects(verify(await token()), error => error.status === 503));
});

test("SingleTenant client uses only the company tenant and Bot scope, exact member and one plain-text write", async () => {
  const client = teamsBotClient(teamsApp, "fixture-secret");
  let authorized = 0;
  const result = await run([{ body: grant }, { body: member }, { body: grant }, { body: { id: "1700000000002" } }], async () => {
    await client.member(reference);
    await client.post(reference, "plain result", async () => { authorized++; });
  });
  assert.equal(authorized, 1);
  const form = Object.fromEntries(result.calls[0].body);
  assert.equal(result.calls[0].url, `https://login.microsoftonline.com/${teamsApp.tenantId}/oauth2/v2.0/token`);
  assert.equal(form.scope, "https://api.botframework.com/.default");
  assert.equal(form.grant_type, "client_credentials");
  assert.ok(result.calls[1].url.endsWith(`/members/${encodeURIComponent(reference.userId)}`));
  assert.equal(JSON.parse(result.calls[3].body).textFormat, "plain");
  assert.equal(result.calls[3].headers.get("authorization"), "Bearer fixture-token");
  await run([{ body: grant }, { body: { id: reference.userId, aadObjectId: reference.userObjectId } }], () => client.member(reference));
  for (const wrong of [{ ...member, objectId: "wrong" }, { ...member, tenantId: "wrong" }, { ...member, aadObjectId: "conflicting" }, {}]) {
    await run([{ body: grant }, { body: wrong }], async () => assert.rejects(client.member(reference), error => error.status === 403));
  }
});

test("Teams post rechecks grant after token and never replays an ambiguous write or follows redirects", async () => {
  const client = teamsBotClient(teamsApp, "fixture-secret");
  const invalidText = await run([], async () => {
    for (const text of ["a\u0000b", "a\u001bb", "a\u007fb", "中".repeat(1400)]) {
      await assert.rejects(client.post(reference, text, async () => {}), error => error.status === 400);
    }
  });
  assert.equal(invalidText.calls.length, 0);
  const revoked = await run([{ body: grant }], async () => assert.rejects(client.post(reference, "blocked", async () => { throw new Error("revoked"); })));
  assert.equal(revoked.calls.length, 1);
  for (const body of [{}, { id: "" }]) {
    const result = await run([{ body: grant }, { body }], async () => assert.rejects(client.post(reference, "once", async () => {}), error => error.status === 502));
    assert.equal(result.calls.length, 2);
  }
  const redirect = await run([{ body: grant }, { status: 302, body: {}, headers: { location: "https://attacker.invalid" } }], async () => assert.rejects(client.post(reference, "once", async () => {})));
  assert.equal(redirect.calls.length, 2);
  assert.ok(redirect.calls.every(call => !call.url.includes("attacker.invalid")));
});

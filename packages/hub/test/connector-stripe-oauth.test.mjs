import assert from "node:assert/strict";
import { test } from "node:test";
import { stubFetchResponses } from "./support/fetch-responses.mjs";
import { exchangeOAuthGrant, grantFieldsForgottenOnDisconnect, oauthAuthorizeUrl, oauthClient, refreshOAuthFields, verifyOAuthState } from "../src/connectors/oauth.ts";
import { stripeAuthorizeEndpoint, stripeConnectOffered, verifyStripe } from "../src/connectors/stripe-oauth.ts";

const secret = ["sk", "live", "fixtureNotARealKey"].join("_");
const trio = {
  CONNECTOR_STRIPE_CLIENT_ID: "ca_fixtureClient",
  CONNECTOR_STRIPE_CLIENT_SECRET: secret,
  CONNECTOR_STRIPE_SIGNING_SECRET: "whsec_fixtureNotARealSecret",
};
const external = "/oauth/v2/chnlink_fixturePath/authorize";
const acceptance = { ...trio, CONNECTOR_STRIPE_EXTERNAL_AUTHORIZE_PATH: external, CONNECTOR_STRIPE_ACCEPTANCE_SPACE_ID: "space-accept" };
const grant = {
  access_token: "fixture-access", refresh_token: "fixture-refresh", stripe_user_id: "acct_fixtureA",
  scope: "stripe_apps", livemode: true, token_type: "bearer",
};

test("Stripe Connect stays hidden until the secret trio and one audience are both configured", () => {
  assert.equal(oauthClient(trio, "stripe")?.clientId, "ca_fixtureClient");
  assert.equal(oauthClient({ ...trio, CONNECTOR_STRIPE_SIGNING_SECRET: "" }, "stripe"), undefined);
  assert.equal(stripeConnectOffered(trio, "space-accept"), false);
  assert.equal(stripeConnectOffered(acceptance, "space-other"), false);
  assert.equal(stripeConnectOffered(acceptance, undefined), false);
  assert.equal(stripeAuthorizeEndpoint(acceptance, "space-accept"), `https://marketplace.stripe.com${external}`);
  const published = { ...acceptance, CONNECTOR_STRIPE_OAUTH_PUBLIC: "marketplace" };
  assert.equal(stripeAuthorizeEndpoint(published, "space-other"), "https://marketplace.stripe.com/oauth/v2/authorize");
});

test("Stripe authorize carries only client id, redirect and state, and the grant records the account", async () => {
  const client = oauthClient(trio, "stripe");
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space-accept", userId: "admin-1",
    connectionSnapshot: { connectionVersion: 2, credentialVersion: 0, connectionGeneration: "generation-1" },
    redirectUri: "https://xmatrix-hub.xmatrix.sh/api/connectors/oauth/callback",
    authorizeUrl: `https://marketplace.stripe.com${external}` }));
  assert.equal(url.pathname, external);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "redirect_uri", "state"]);
  const verified = await verifyOAuthState(trio, url.searchParams.get("state"));
  assert.equal(verified.connectionSnapshot.connectionVersion, 2);
  assert.ok(verified.authorizationStartedAt <= Date.now());
  await assert.rejects(oauthAuthorizeUrl(client, { spaceId: "s", userId: "u", redirectUri: "https://hub.test/cb",
    authorizeUrl: "https://example.com/oauth/v2/authorize" }), /not configured/);

  const fetch = stubFetchResponses([{ body: { ...grant } }], {
    decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body) : undefined,
  });
  try {
    const exchanged = await exchangeOAuthGrant(client, "code-1", "https://hub.test/cb");
    assert.equal(fetch.calls[0].headers.get("authorization"), `Basic ${btoa(`${secret}:`)}`);
    assert.deepEqual(fetch.calls[0].body, { grant_type: "authorization_code", code: "code-1" });
    assert.equal(exchanged.fields.oauthToken, "fixture-access");
    assert.equal(exchanged.fields.stripeUserId, "acct_fixtureA");
    assert.equal(exchanged.installation.installationId, "acct_fixtureA");
    assert.ok(Math.abs(Number(exchanged.fields.oauthExpiresAt) - Date.now() - 3_600_000) < 5_000);
  } finally { fetch.restore(); }
  assert.deepEqual(Object.keys(grantFieldsForgottenOnDisconnect("stripe")).sort(),
    ["oauthExpiresAt", "oauthRefreshToken", "oauthToken", "stripeAccounts", "stripeUserId"]);
});

test("Stripe refresh requires the same account and a pasted secret does not call Stripe", async () => {
  const client = oauthClient(trio, "stripe");
  const now = Date.now();
  const stored = { oauthToken: "old-access", oauthRefreshToken: "old-refresh", stripeUserId: "acct_fixtureA",
    oauthExpiresAt: String(now + 30_000) };
  const fetch = stubFetchResponses([{ body: { ...grant, refresh_token: "rotated-refresh" } }], {
    decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body) : undefined,
  });
  try {
    const fields = await refreshOAuthFields(trio, "stripe", stored, now);
    assert.equal(fetch.calls[0].body.grant_type, "refresh_token");
    assert.equal(fields.oauthRefreshToken, "rotated-refresh");
    assert.equal(fields.stripeUserId, undefined);
  } finally { fetch.restore(); }
  const mismatch = stubFetchResponses([{ body: { ...grant, stripe_user_id: "acct_other" } }], {
    decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body) : undefined,
  });
  try {
    await assert.rejects(refreshOAuthFields(trio, "stripe", stored, now), /expiring Stripe App grant/);
  } finally { mismatch.restore(); }
  const idle = stubFetchResponses([], { allowUnexpected: false });
  try { await verifyStripe({ signingSecret: "whsec_fixture" }); assert.equal(idle.calls.length, 0); }
  finally { idle.restore(); }
  const check = stubFetchResponses([{ body: { object: "list", data: [] } }]);
  try {
    await verifyStripe({ oauthToken: "fixture-access", stripeUserId: "acct_fixtureA" });
    assert.equal(check.calls[0].headers.get("authorization"), `Basic ${btoa("fixture-access:")}`);
    assert.equal(check.calls[0].url, "https://api.stripe.com/v1/events?limit=1");
  } finally { check.restore(); }
  const wrong = stubFetchResponses([{ body: { id: "acct_other" } }]);
  try { await assert.rejects(verifyStripe({ oauthToken: "fixture-access", stripeUserId: "acct_fixtureA" }), /did not confirm event access/); }
  finally { wrong.restore(); }
  const denied = stubFetchResponses([{ status: 403, body: { error: { message: "permission denied" } } }]);
  try { await assert.rejects(verifyStripe({ oauthToken: "fixture-access", stripeUserId: "acct_fixtureA" }), /Stripe refused/); }
  finally { denied.restore(); }
  assert.equal(client.manifest.oauth.flow, "stripe-app");
});

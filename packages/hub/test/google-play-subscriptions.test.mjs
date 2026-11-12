import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { exportJWK, SignJWT, createLocalJWKSet, importPKCS8 } from "jose";
import { acknowledgeGooglePlaySubscription, googlePlayBillingFact, googlePlaySubscriptionConfig, GooglePlayBillingError,
  retrieveGooglePlaySubscription, subscriptionFact, verifyGooglePlayPush } from "../src/google-play/subscriptions.ts";

const { privateKey: rsa, publicKey: rsaPublic } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = rsa.export({ type: "pkcs8", format: "pem" });
const config = { serviceAccountEmail: "play-api@xmatrix-test.iam.gserviceaccount.com", privateKey,
  subscriptionId: "pro", monthlyBasePlanId: "monthly", annualBasePlanId: "annual",
  pushAudience: "https://xmatrix-hub.example/api/billing/google-play/notifications",
  pushServiceAccountEmail: "play-push@xmatrix-test.iam.gserviceaccount.com", testSpaceIds: ["test-space"] };
const accountToken = "00000000-0000-4000-8000-000000000002";
const purchaseToken = "opaque-play-purchase-token.AO-J1Oz_example_0123456789";
const now = Date.now();
const purchase = (changes = {}, item = {}) => ({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  externalAccountIdentifiers: { obfuscatedExternalAccountId: accountToken },
  lineItems: [{ productId: "pro", expiryTime: new Date(now + 3600_000).toISOString(), autoRenewingPlan: { autoRenewEnabled: true },
    offerDetails: { basePlanId: "monthly" }, ...item }], ...changes });

test("configuration is atomic and never echoes the supplied key", () => {
  assert.deepEqual(googlePlaySubscriptionConfig(JSON.stringify(config)), config);
  for (const changed of [undefined, "private sentinel", JSON.stringify({ ...config, privateKey: "private sentinel" }),
    JSON.stringify({ ...config, annualBasePlanId: "monthly" }), JSON.stringify({ ...config, packageName: "other" }),
    JSON.stringify({ ...config, serviceAccountEmail: "someone@gmail.com" }), JSON.stringify({ ...config, testSpaceIds: [null] })]) {
    assert.throws(() => googlePlaySubscriptionConfig(changed), (error) => error instanceof GooglePlayBillingError &&
      error.code === "google_play_billing_unavailable" && !error.message.includes("sentinel") && error.message.includes("GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG"));
  }
});

test("a paid purchase is one seat bound by its account token, keyed by the token's digest", async () => {
  const verified = await subscriptionFact(config, purchaseToken, purchase(), now);
  assert.equal(verified.active, true);
  assert.equal(verified.environment, "Production");
  assert.equal(verified.interval, "month");
  assert.equal(verified.needsAcknowledgement, true);
  assert.match(verified.purchaseTokenDigest, /^[0-9a-f]{64}$/);
  const fact = googlePlayBillingFact(verified, { spaceId: "space", ownerUserId: "owner" });
  assert.equal(fact.billingProvider, "google");
  assert.equal(fact.id, `google:Production:${verified.purchaseTokenDigest.slice(0, 40)}`);
  assert.ok(!fact.id.includes(purchaseToken), "the purchase token is not stored");
  assert.equal(fact.quantity, 1);
  assert.equal(fact.customerId, accountToken);
  assert.equal(fact.status, "active");
  assert.throws(() => googlePlayBillingFact(verified, { spaceId: "space", ownerUserId: "owner", accountDeleted: true }), GooglePlayBillingError);
});

test("states map to access from Google's facts, not the client's success screen", async () => {
  const fact = async (state, item) => googlePlayBillingFact(await subscriptionFact(config, purchaseToken,
    purchase({ subscriptionState: state }, item), now), { spaceId: "s", ownerUserId: "o" });
  const canceled = await fact("SUBSCRIPTION_STATE_CANCELED", { autoRenewingPlan: { autoRenewEnabled: false } });
  assert.equal(canceled.status, "active", "turning renewal off keeps the paid period");
  assert.equal(canceled.cancelAtPeriodEnd, true);
  assert.equal((await fact("SUBSCRIPTION_STATE_IN_GRACE_PERIOD")).status, "active");
  assert.equal((await fact("SUBSCRIPTION_STATE_ON_HOLD")).status, "unpaid");
  assert.equal((await fact("SUBSCRIPTION_STATE_PAUSED")).status, "paused");
  assert.equal((await fact("SUBSCRIPTION_STATE_EXPIRED")).status, "canceled");
  assert.equal((await fact("SUBSCRIPTION_STATE_PENDING", { expiryTime: undefined })).status, "incomplete");
  assert.equal((await fact("SUBSCRIPTION_STATE_ACTIVE", { expiryTime: new Date(now - 1).toISOString() })).status, "canceled");
  const held = await subscriptionFact(config, purchaseToken, purchase({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD" }), now);
  assert.equal(held.needsAcknowledgement, false, "only a paid purchase is acknowledged");
  assert.equal((await subscriptionFact(config, purchaseToken, purchase({ testPurchase: {} }), now)).environment, "Test");
});

test("product, base plan and account token are checked", async () => {
  for (const [changes, item] of [[{}, { productId: "other" }], [{}, { offerDetails: { basePlanId: "weekly" } }],
    [{ externalAccountIdentifiers: {} }, {}], [{ externalAccountIdentifiers: { obfuscatedExternalAccountId: "user-1" } }, {}],
    [{ subscriptionState: "ACTIVE" }, {}], [{}, { expiryTime: "soon" }], [{ lineItems: [] }, {}]]) {
    await assert.rejects(subscriptionFact(config, purchaseToken, purchase(changes, item), now), GooglePlayBillingError, JSON.stringify([changes, item]));
  }
});

test("verification signs as the service account, reads a fixed host and acknowledges on the same token", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(init.body).get("assertion");
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
      assert.equal(claims.iss, config.serviceAccountEmail);
      assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
      return Response.json({ access_token: "access" });
    }
    return String(url).endsWith(":acknowledge") ? new Response(null, { status: 200 }) : Response.json(purchase());
  };
  const verified = await retrieveGooglePlaySubscription(config, purchaseToken, fetchImpl);
  assert.equal(verified.active, true);
  await acknowledgeGooglePlaySubscription(config, purchaseToken, fetchImpl);
  const reads = calls.filter((call) => !call.url.includes("oauth2"));
  assert.equal(reads[0].url, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/sh.xmatrix.app/purchases/subscriptionsv2/tokens/${purchaseToken}`);
  assert.equal(reads[0].init.redirect, "manual");
  assert.equal(reads[1].url, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/sh.xmatrix.app/purchases/subscriptions/pro/tokens/${purchaseToken}:acknowledge`);
  await assert.rejects(retrieveGooglePlaySubscription(config, "../escape", fetchImpl), GooglePlayBillingError);
  const outage = await retrieveGooglePlaySubscription(config, purchaseToken, async (url) =>
    String(url).includes("oauth2") ? Response.json({ access_token: "a" }) : new Response("busy", { status: 503 })).catch((error) => error);
  assert.equal(outage.retryable, true);
  const refused = await retrieveGooglePlaySubscription(config, purchaseToken, async (url) =>
    String(url).includes("oauth2") ? Response.json({ access_token: "a" }) : new Response("gone", { status: 410 })).catch((error) => error);
  assert.equal(refused.retryable, false);
});

test("a push is accepted only with Google's OIDC token for the push service account, and only names a token", async () => {
  const jwk = { ...(await exportJWK(rsaPublic)), kid: "k1", alg: "RS256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const signer = await importPKCS8(privateKey, "RS256");
  const sign = (claims, audience = config.pushAudience) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com").setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(signer);
  const envelope = (note) => ({ message: { data: Buffer.from(JSON.stringify(note)).toString("base64"), messageId: "1" }, subscription: "projects/p/subscriptions/s" });
  const note = { version: "1.0", packageName: "sh.xmatrix.app", eventTimeMillis: String(now),
    subscriptionNotification: { version: "1.0", notificationType: 4, purchaseToken, subscriptionId: "pro" } };
  const good = `Bearer ${await sign({ email: config.pushServiceAccountEmail, email_verified: true })}`;
  assert.deepEqual(await verifyGooglePlayPush(config, good, envelope(note), keys), { purchaseToken });
  assert.equal(await verifyGooglePlayPush(config, good, envelope({ version: "1.0", packageName: "sh.xmatrix.app", testNotification: { version: "1.0" } }), keys), null);
  await assert.rejects(verifyGooglePlayPush(config, good, envelope({ ...note, packageName: "other.app" }), keys), GooglePlayBillingError);
  await assert.rejects(verifyGooglePlayPush(config, null, envelope(note), keys), GooglePlayBillingError);
  for (const bad of [await sign({ email: "someone@xmatrix-test.iam.gserviceaccount.com", email_verified: true }),
    await sign({ email: config.pushServiceAccountEmail, email_verified: false }),
    await sign({ email: config.pushServiceAccountEmail, email_verified: true }, "https://elsewhere.example")]) {
    await assert.rejects(verifyGooglePlayPush(config, `Bearer ${bad}`, envelope(note), keys), GooglePlayBillingError);
  }
});

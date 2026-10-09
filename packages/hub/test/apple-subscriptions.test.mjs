import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { appleSubscriptionConfig, AppleBillingError, subscriptionFact, appleBillingFact, retrieveAppleSubscription, verifyAppleNotification } from "../src/apple/subscriptions.ts";

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
const config = { keyId: "TESTKEY000", issuerId: "00000000-0000-4000-8000-000000000001", privateKey,
  appAppleId: 123, monthlyProductId: "test.pro.month", annualProductId: "test.pro.year", sandboxSpaceIds: ["test-space"] };
const token = "00000000-0000-4000-8000-000000000002";
const now = Date.now();
const transaction = { productId: config.monthlyProductId, type: "Auto-Renewable Subscription", inAppOwnershipType: "PURCHASED",
  appAccountToken: token, originalTransactionId: "100", transactionId: "101", expiresDate: now + 3600_000,
  signedDate: now - 1000, environment: "Production", bundleId: "sh.xmatrix.app" };
const renewal = { originalTransactionId: "100", signedDate: now - 500, autoRenewStatus: 1 };

test("configuration is atomic and rejects unknown fields without exposing the supplied secret", () => {
  assert.deepEqual(appleSubscriptionConfig(JSON.stringify(config)), config);
  for (const changed of [undefined, "private sentinel", JSON.stringify({ ...config, privateKey: "private sentinel" }),
    JSON.stringify({ ...config, monthlyProductId: config.annualProductId }), JSON.stringify({ ...config, environment: "Xcode" }),
    JSON.stringify({ ...config, sandboxSpaceIds: [null] })]) {
    assert.throws(() => appleSubscriptionConfig(changed), (error) => error instanceof AppleBillingError && !error.message.includes("sentinel"));
  }
});

test("verified renewal has one seat, exact owner/Space and a namespaced immutable original transaction", () => {
  const verified = subscriptionFact(config, "Production", 1, transaction, renewal);
  assert.equal(verified.active, true);
  assert.equal(verified.appAccountToken, token);
  const fact = appleBillingFact(verified, { spaceId: "space", ownerUserId: "owner" });
  assert.equal(fact.billingProvider, "apple");
  assert.equal(fact.id, "apple:Production:100");
  assert.equal(fact.quantity, 1);
  assert.equal(fact.spaceId, "space");
  assert.equal(fact.billingOwnerUserId, "owner");
});

test("expiry, refunds, retry and grace use Apple facts, not the client's success screen", () => {
  assert.equal(subscriptionFact(config, "Production", 1, { ...transaction, expiresDate: now - 1 }, renewal).active, false);
  assert.equal(subscriptionFact(config, "Production", 1, { ...transaction, revocationDate: now - 1 }, renewal).active, false);
  assert.equal(subscriptionFact(config, "Production", 5, transaction, renewal).active, false);
  const retry = subscriptionFact(config, "Production", 3, transaction, renewal);
  assert.equal(retry.active, false); assert.equal(retry.retrying, true);
  assert.equal(subscriptionFact(config, "Production", 4, { ...transaction, expiresDate: now - 1 }, { ...renewal, gracePeriodExpiresDate: now + 10000 }).active, true);
  assert.equal(subscriptionFact(config, "Production", 1, transaction, { ...renewal, autoRenewStatus: 0 }).active, true, "cancelling renewal does not revoke the paid period");
});

test("bundle, product, environment, account binding and ownership are checked", () => {
  for (const changed of [{ bundleId: "another.app" }, { environment: "Sandbox" }, { productId: "other" },
    { inAppOwnershipType: "FAMILY_SHARED" }, { appAccountToken: "not-a-uuid" }, { originalTransactionId: "../other" },
    { signedDate: now + 3600_000 }, { expiresDate: undefined }]) {
    assert.throws(() => subscriptionFact(config, "Production", 1, { ...transaction, ...changed }, renewal));
  }
});

test("malformed/unsigned notifications never become entitlement evidence", async () => {
  await assert.rejects(verifyAppleNotification(config, "not-a-signed-payload"), /verification failed/);
  await assert.rejects(verifyAppleNotification(config, "x".repeat(64001)), /Invalid Apple notification/);
});

test("Apple API credentials stay in the header, destinations are fixed, and failure bodies are not reflected", async () => {
  let calls = 0;
  await assert.rejects(retrieveAppleSubscription(config, "100", "Production", async (url, init) => {
    calls++; assert.equal(url, "https://api.storekit.apple.com/inApps/v1/subscriptions/100");
    assert.equal(init.redirect, "manual"); assert.ok(init.signal);
    const payload = JSON.parse(Buffer.from(init.headers.authorization.split(".")[1], "base64url").toString());
    assert.equal(payload.bid, "sh.xmatrix.app");
    return new Response("private sentinel", { status: 401 });
  }), (error) => error.code === "apple_request_failed" && !error.message.includes("sentinel"));
  assert.equal(calls, 1);
  await assert.rejects(retrieveAppleSubscription(config, "../../secrets", "Production", async () => { throw new Error("must not fetch"); }), /Invalid Apple transaction/);
  await assert.rejects(retrieveAppleSubscription(config, "100", "Xcode", async () => { throw new Error("must not fetch"); }), /Invalid Apple environment/);
});

test("a verified Apple purchase never grants access to a retired identity", () => {
  const verified = subscriptionFact(config, "Production", 1, transaction, renewal);
  assert.throws(() => appleBillingFact(verified, { spaceId: "space", ownerUserId: "owner", accountDeleted: true }),
    { code: "apple_purchase_account_deleted" });
});

 test("Apple redirects are rejected without following or exposing the destination", async () => {
  let calls = 0;
  await assert.rejects(retrieveAppleSubscription(config, "100", "Sandbox", async (url, init) => {
    calls++;
    assert.equal(url, "https://api.storekit-sandbox.apple.com/inApps/v1/subscriptions/100");
    assert.equal(init.redirect, "manual");
    return new Response("private sentinel", { status: 302, headers: { location: "https://untrusted.example/private" } });
  }), (error) => error.code === "apple_request_failed" && !error.message.includes("private") && !error.retryable);
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  StripeBillingError,
  createStripeCheckoutSession,
  retrieveStripeSubscription,
  stripeCheckoutReturnUrls,
  stripeCheckoutSessionFact,
  stripeSubscriptionFact,
  stripeWebhookSubscriptionId,
  verifyStripeWebhookSignature,
} from "../src/billing-stripe.ts";

const checkoutReturn = stripeCheckoutReturnUrls("https://app.test.example", "space-1");

function withFetch(stub, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(callback()).finally(() => {
    globalThis.fetch = previous;
  });
}

test("Checkout request carries the Authority identity, tax, interval policy, and idempotency key", async () => {
  let request;
  await withFetch(async (url, init) => {
    request = { url, init };
    return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  }, async () => {
    const result = await createStripeCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_monthly",
      seatQuantity: 3,
      successUrl: checkoutReturn.successUrl,
      cancelUrl: checkoutReturn.cancelUrl,
      spaceId: "space-1",
      billingOwnerUserId: "owner-1",
      checkoutIntentId: "intent-1",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      allowPromotionCodes: true,
    });
    assert.deepEqual(result, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  });
  assert.equal(request.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["idempotency-key"], "intent-1");
  assert.equal(request.init.headers["Stripe-Version"], "2025-11-17.clover");
  const form = new URLSearchParams(request.init.body);
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price]"), "price_monthly");
  assert.equal(form.get("line_items[0][quantity]"), "3");
  assert.equal(form.get("metadata[xmatrix_space_id]"), "space-1");
  assert.equal(form.get("metadata[xmatrix_billing_owner_user_id]"), "owner-1");
  assert.equal(form.get("metadata[xmatrix_checkout_intent_id]"), "intent-1");
  assert.equal(form.get("subscription_data[metadata][xmatrix_checkout_intent_id]"), "intent-1");
  assert.equal(form.get("automatic_tax[enabled]"), "true");
  assert.equal(form.get("allow_promotion_codes"), "true");
  assert.equal(form.get("success_url")?.includes("{CHECKOUT_SESSION_ID}"), true);
  assert.equal(form.get("success_url")?.includes("%7BCHECKOUT_SESSION_ID%7D"), false);
});

test("Checkout success URL keeps Stripe's session placeholder unencoded", () => {
  const encoded = new URL("https://xmatrix.sh/billing");
  encoded.searchParams.set("space", "space-1");
  encoded.searchParams.set("checkout", "success");
  encoded.searchParams.set("checkout_session_id", "{CHECKOUT_SESSION_ID}");
  assert.equal(encoded.toString().includes("%7BCHECKOUT_SESSION_ID%7D"), true);
  const urls = stripeCheckoutReturnUrls("https://xmatrix.sh", "space-1");
  assert.equal(urls.successUrl.includes("{CHECKOUT_SESSION_ID}"), true);
  assert.equal(urls.successUrl.includes("%7BCHECKOUT_SESSION_ID%7D"), false);
  assert.match(urls.successUrl, /space=space-1/);
  assert.match(urls.successUrl, /checkout=success/);
  assert.match(urls.cancelUrl, /checkout=cancelled/);
});

test("Checkout rejects a percent-encoded session placeholder before calling Stripe", async () => {
  await withFetch(async () => {
    throw new Error("Stripe must not be called");
  }, async () => {
    await assert.rejects(
      createStripeCheckoutSession(checkoutInput({
        successUrl: "https://xmatrix.sh/billing?checkout=success&checkout_session_id=%7BCHECKOUT_SESSION_ID%7D",
        allowPromotionCodes: true,
      })),
      (error) => error instanceof StripeBillingError && error.message === "Stripe checkout success URL is invalid",
    );
  });
});

test("Stripe request failures expose the provider code without treating 4xx as retryable", async () => {
  await withFetch(async () => Response.json({
    error: { type: "invalid_request_error", code: "more_permissions_required" },
  }, { status: 403 }), async () => {
    await assert.rejects(
      createStripeCheckoutSession(checkoutInput()),
      (error) => error instanceof StripeBillingError
        && error.retryable === false
        && error.providerCode === "more_permissions_required",
    );
  });
});

test("Stripe webhook signature verification accepts only a current matching v1 signature", async () => {
  const body = '{"id":"evt_1"}';
  const secret = "whsec_test";
  const timestamp = 1_700_000_000;
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  await verifyStripeWebhookSignature({
    body,
    secret,
    signature: `t=${timestamp},v1=${digest}`,
    nowMs: timestamp * 1_000,
  });
  await assert.rejects(
    verifyStripeWebhookSignature({
      body,
      secret,
      signature: `t=${timestamp},v1=${"0".repeat(64)}`,
      nowMs: timestamp * 1_000,
    }),
    (error) => error instanceof StripeBillingError && error.retryable === false,
  );
  await assert.rejects(
    verifyStripeWebhookSignature({
      body,
      secret,
      signature: `t=${timestamp},v1=${digest}`,
      nowMs: (timestamp + 301) * 1_000,
    }),
    /signature is invalid/u,
  );
});

test("Checkout and subscription facts fail closed unless provider metadata binds to the Authority intent", () => {
  const session = stripeCheckoutSessionFact({
    id: "cs_test_1",
    status: "complete",
    client_reference_id: "intent-1",
    subscription: "sub-1",
    metadata: {
      xmatrix_space_id: "space-1",
      xmatrix_billing_owner_user_id: "owner-1",
      xmatrix_checkout_intent_id: "intent-1",
    },
  });
  assert.deepEqual(session, {
    id: "cs_test_1",
    subscriptionId: "sub-1",
    spaceId: "space-1",
    billingOwnerUserId: "owner-1",
    checkoutIntentId: "intent-1",
    status: "complete",
  });
  assert.throws(() => stripeCheckoutSessionFact({
    id: "cs_test_1",
    status: "complete",
    client_reference_id: "wrong-intent",
    subscription: "sub-1",
    metadata: {
      xmatrix_space_id: "space-1",
      xmatrix_billing_owner_user_id: "owner-1",
      xmatrix_checkout_intent_id: "intent-1",
    },
  }), /intent is invalid/u);

  const subscription = stripeSubscriptionFact({
    id: "sub-1",
    customer: "cus-1",
    status: "active",
    current_period_end: 1_700_000_000,
    cancel_at_period_end: false,
    metadata: {
      xmatrix_space_id: "space-1",
      xmatrix_billing_owner_user_id: "owner-1",
      xmatrix_checkout_intent_id: "intent-1",
    },
    items: { data: [{ quantity: 3, price: { id: "price_monthly" } }] },
  });
  assert.equal(subscription.spaceId, "space-1");
  assert.equal(subscription.billingOwnerUserId, "owner-1");
  assert.equal(subscription.checkoutIntentId, "intent-1");
  assert.equal(subscription.quantity, 3);
  assert.equal(subscription.currentPeriodEnd, "2023-11-14T22:13:20.000Z");
  assert.throws(() => stripeSubscriptionFact({
    id: "sub-1",
    customer: "cus-1",
    status: "active",
    metadata: { xmatrix_space_id: "space-1" },
    items: { data: [{ quantity: 3, price: { id: "price_monthly" } }] },
  }), /metadata\.xmatrix_billing_owner_user_id is invalid/u);
});

test("subscription retrieval pins the response version independently of a new account's default", async () => {
  await withFetch(async (url, init) => {
    assert.equal(url, "https://api.stripe.com/v1/subscriptions/sub_1");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["Stripe-Version"], "2025-11-17.clover");
    return Response.json({ id: "sub_1" });
  }, async () => {
    assert.deepEqual(await retrieveStripeSubscription("sk_test_secret", "sub_1"), { id: "sub_1" });
  });
});

test("invoice references work across legacy and parent-based events, including expanded references", () => {
  for (const eventType of ["invoice.paid", "invoice.payment_failed"]) {
    assert.equal(stripeWebhookSubscriptionId(eventType, { subscription: "sub_1" }), "sub_1");
    assert.equal(stripeWebhookSubscriptionId(eventType, {
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
    }), "sub_1");
    assert.equal(stripeWebhookSubscriptionId(eventType, {
      parent: { type: "subscription_details", subscription_details: { subscription: { id: "sub_1" } } },
    }), "sub_1");
    assert.equal(stripeWebhookSubscriptionId(eventType, { parent: null, subscription: null }), null);
    assert.equal(stripeWebhookSubscriptionId(eventType, {
      parent: { type: "quote_details", subscription_details: { subscription: "sub_wrong" } },
      subscription: "sub_wrong",
    }), null);
    assert.throws(() => stripeWebhookSubscriptionId(eventType, {
      parent: { type: "subscription_details", subscription_details: [] },
      subscription: "sub_wrong",
    }), /Stripe invoice subscription details is invalid/u);
  }
  for (const eventType of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
    assert.equal(stripeWebhookSubscriptionId(eventType, { id: "sub_1" }), "sub_1");
  }
  assert.equal(stripeWebhookSubscriptionId("checkout.session.completed", { subscription: "sub_1" }), "sub_1");
  assert.equal(stripeWebhookSubscriptionId("customer.updated", { subscription: "sub_wrong" }), null);
});

test("subscription facts read item billing periods and retain the single-item authority boundary", () => {
  const subscription = {
    id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: true,
    metadata: { xmatrix_space_id: "space_1", xmatrix_billing_owner_user_id: "owner_1" },
    items: { data: [{ quantity: 1, price: { id: "price_monthly" }, current_period_end: 1_800_000_000 }] },
  };
  const fact = stripeSubscriptionFact(subscription);
  assert.equal(fact.currentPeriodEnd, "2027-01-15T08:00:00.000Z");
  assert.equal(fact.cancelAtPeriodEnd, true);
  assert.equal(stripeSubscriptionFact({ ...subscription, current_period_end: 1_700_000_000 }).currentPeriodEnd, fact.currentPeriodEnd);
  assert.throws(() => stripeSubscriptionFact({
    ...subscription, items: { data: [...subscription.items.data, ...subscription.items.data] },
  }), /Stripe subscription items are invalid/u);
});

function checkoutInput(overrides = {}) {
  return { secretKey: "sk_test_secret", priceId: "price_monthly", seatQuantity: 1,
    successUrl: checkoutReturn.successUrl, cancelUrl: checkoutReturn.cancelUrl, spaceId: "space-1",
    billingOwnerUserId: "owner-1", checkoutIntentId: "intent-1",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), allowPromotionCodes: false, ...overrides };
}

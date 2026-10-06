import type { StripeSubscriptionFact } from "@xmatrix/db";
import { hmacHex, timingSafeEqual } from "@xmatrix/protocol";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2025-11-17.clover";
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
export const STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

export function stripeCheckoutReturnUrls(publicAppOrigin: string, spaceId: string): { successUrl: string; cancelUrl: string } {
  const destination = new URL("/billing", publicAppOrigin);
  destination.searchParams.set("space", spaceId);
  const cancelUrl = new URL(destination);
  cancelUrl.searchParams.set("checkout", "cancelled");
  const successUrl = new URL(destination);
  successUrl.searchParams.set("checkout", "success");
  // Stripe replaces this token only when the curly braces remain unencoded in
  // the success_url value. URLSearchParams would turn it into %7B...%7D.
  return {
    successUrl: `${successUrl.toString()}&checkout_session_id=${STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    cancelUrl: cancelUrl.toString(),
  };
}

export class StripeBillingError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly providerCode?: string,
    /** Stripe's HTTP status, when Stripe itself answered the request. */
    readonly providerStatus?: number,
  ) {
    super(message);
  }

  /**
   * Stripe answered that the object xMatrix asked for does not exist, such as
   * a recorded subscription Stripe no longer has. That is a fact about the
   * referenced object, answered to the caller, not a failed Hub request.
   */
  get providerObjectMissing(): boolean {
    return this.providerStatus === 404 && this.providerCode === "resource_missing";
  }
}

/** The HTTP status a billing route answers a Stripe failure with. */
export function stripeBillingErrorStatus(error: StripeBillingError): 409 | 502 | 503 {
  if (error.providerObjectMissing) return 409;
  return error.retryable ? 503 : 502;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StripeBillingError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new StripeBillingError(`${label} is invalid`);
  }
  return value.trim();
}

function metadataText(metadata: Record<string, unknown>, name: string): string {
  return text(metadata[name], `metadata.${name}`);
}

export async function verifyStripeWebhookSignature(input: {
  body: string;
  signature: string | null;
  secret: string | undefined;
  nowMs?: number;
}): Promise<void> {
  if (!input.secret) throw new StripeBillingError("Stripe webhook is not configured", true);
  if (!input.signature) throw new StripeBillingError("Stripe signature is missing");
  const parts = input.signature.split(",").map((part) => part.trim());
  const timestampValue = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  const timestamp = Number(timestampValue);
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  if (!Number.isSafeInteger(timestamp) || !signatures.length || Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new StripeBillingError("Stripe signature is invalid");
  }
  const expected = await hmacHex("SHA-256", input.secret, `${timestamp}.${input.body}`);
  if (!signatures.some((candidate) => timingSafeEqual(expected, candidate))) {
    throw new StripeBillingError("Stripe signature is invalid");
  }
}

async function stripeRequest(
  secretKey: string,
  path: string,
  init: { method?: "GET" | "POST"; form?: URLSearchParams; idempotencyKey?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
    },
    ...(init.form ? { body: init.form.toString() } : {}),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new StripeBillingError("Stripe returned an invalid response", response.status >= 500);
  }
  if (!response.ok) {
    const stripeError = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).error
      : undefined;
    const providerCode = stripeError && typeof stripeError === "object" && !Array.isArray(stripeError)
      && typeof (stripeError as Record<string, unknown>).code === "string"
      ? ((stripeError as Record<string, unknown>).code as string).trim().slice(0, 80)
      : undefined;
    const missing = response.status === 404 && providerCode === "resource_missing";
    // A missing object is answered to the caller; every other refusal is a
    // Stripe or configuration failure worth an error report.
    (missing ? console.warn : console.error)(JSON.stringify({
      event: missing ? "xmatrix_stripe_resource_missing" : "xmatrix_stripe_error",
      status: response.status,
      code: providerCode || null,
    }));
    throw new StripeBillingError(
      missing ? "Stripe has no record of this billing object" : "Stripe could not complete the billing request",
      response.status >= 500 || response.status === 429,
      providerCode || undefined,
      response.status,
    );
  }
  return record(payload, "Stripe response");
}

export async function createStripeCheckoutSession(input: {
  secretKey: string;
  priceId: string;
  seatQuantity: number;
  successUrl: string;
  cancelUrl: string;
  spaceId: string;
  billingOwnerUserId: string;
  checkoutIntentId: string;
  expiresAt: string;
  allowPromotionCodes: boolean;
}): Promise<{ id: string; url: string }> {
  const expiresAtSeconds = Math.floor(Date.parse(input.expiresAt) / 1_000);
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1_000)) {
    throw new StripeBillingError("Stripe checkout expiry is invalid");
  }
  if (
    !input.successUrl.includes(STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER)
    || input.successUrl.includes("%7BCHECKOUT_SESSION_ID%7D")
  ) {
    throw new StripeBillingError("Stripe checkout success URL is invalid");
  }
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": String(input.seatQuantity),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.checkoutIntentId,
    expires_at: String(expiresAtSeconds),
    "metadata[xmatrix_space_id]": input.spaceId,
    "metadata[xmatrix_billing_owner_user_id]": input.billingOwnerUserId,
    "metadata[xmatrix_checkout_intent_id]": input.checkoutIntentId,
    "subscription_data[metadata][xmatrix_space_id]": input.spaceId,
    "subscription_data[metadata][xmatrix_billing_owner_user_id]": input.billingOwnerUserId,
    "subscription_data[metadata][xmatrix_checkout_intent_id]": input.checkoutIntentId,
    "automatic_tax[enabled]": "true",
    allow_promotion_codes: input.allowPromotionCodes ? "true" : "false",
  });
  // The Authority-owned intent id survives browser retries and unknown network
  // outcomes. It is the only Stripe idempotency key for this Session.
  const payload = await stripeRequest(input.secretKey, "/checkout/sessions", {
    method: "POST",
    form,
    idempotencyKey: input.checkoutIntentId,
  });
  const id = text(payload.id, "Stripe checkout session id");
  const url = text(payload.url, "Stripe checkout URL", 2_048);
  if (!url.startsWith("https://checkout.stripe.com/")) throw new StripeBillingError("Stripe checkout URL is invalid");
  return { id, url };
}

export async function createStripeBillingPortalSession(input: {
  secretKey: string;
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const form = new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl });
  const payload = await stripeRequest(input.secretKey, "/billing_portal/sessions", { method: "POST", form });
  const url = text(payload.url, "Stripe billing portal URL", 2_048);
  if (!url.startsWith("https://billing.stripe.com/")) throw new StripeBillingError("Stripe billing portal URL is invalid");
  return { url };
}

export async function retrieveStripeSubscription(secretKey: string, subscriptionId: string): Promise<Record<string, unknown>> {
  return stripeRequest(secretKey, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function retrieveStripeCheckoutSession(secretKey: string, sessionId: string): Promise<Record<string, unknown>> {
  return stripeRequest(secretKey, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

function objectOrTextId(value: unknown, label: string): string {
  if (typeof value === "string") return text(value, label);
  return text(record(value, label).id, `${label}.id`);
}

/** Extract only the subscription reference; current facts are retrieved separately. */
export function stripeWebhookSubscriptionId(eventType: string, object: Record<string, unknown>): string | null {
  let reference: unknown;
  if (eventType.startsWith("customer.subscription.")) {
    reference = object.id;
  } else if (eventType === "checkout.session.completed") {
    reference = object.subscription;
  } else if (eventType === "invoice.paid" || eventType === "invoice.payment_failed") {
    if (object.parent != null) {
      const parent = record(object.parent, "Stripe invoice parent");
      if (parent.type !== "subscription_details") return null;
      reference = record(parent.subscription_details, "Stripe invoice subscription details").subscription;
    } else {
      // Pre-Basil invoice events carry their reference at the top level.
      reference = object.subscription;
    }
  } else {
    return null;
  }
  return reference == null ? null : objectOrTextId(reference, "Stripe webhook subscription");
}

/** The Session is the return-path proof; its metadata must bind to Authority's intent. */
export function stripeCheckoutSessionFact(value: unknown): {
  id: string;
  subscriptionId: string;
  spaceId: string;
  billingOwnerUserId: string;
  checkoutIntentId: string;
  status: "open" | "complete" | "expired";
} {
  const session = record(value, "Stripe checkout session");
  const metadata = record(session.metadata, "Stripe checkout session metadata");
  const status = text(session.status, "Stripe checkout session status", 32) as "open" | "complete" | "expired";
  if (status !== "open" && status !== "complete" && status !== "expired") {
    throw new StripeBillingError("Stripe checkout session status is unsupported");
  }
  const checkoutIntentId = metadataText(metadata, "xmatrix_checkout_intent_id");
  if (session.client_reference_id !== checkoutIntentId) {
    throw new StripeBillingError("Stripe checkout session intent is invalid");
  }
  return {
    id: text(session.id, "Stripe checkout session id"),
    subscriptionId: objectOrTextId(session.subscription, "Stripe checkout session subscription"),
    spaceId: metadataText(metadata, "xmatrix_space_id"),
    billingOwnerUserId: metadataText(metadata, "xmatrix_billing_owner_user_id"),
    checkoutIntentId,
    status,
  };
}

export function stripeSubscriptionFact(value: unknown): StripeSubscriptionFact {
  const subscription = record(value, "Stripe subscription");
  const metadata = record(subscription.metadata, "Stripe subscription metadata");
  const items = record(subscription.items, "Stripe subscription items");
  const data = items.data;
  if (!Array.isArray(data) || data.length !== 1) throw new StripeBillingError("Stripe subscription items are invalid");
  const line = record(data[0], "Stripe subscription line item");
  const price = record(line.price, "Stripe subscription price");
  const status = text(subscription.status, "Stripe subscription status", 64) as StripeSubscriptionFact["status"];
  if (!["trialing", "active", "past_due", "incomplete", "incomplete_expired", "unpaid", "canceled", "paused"].includes(status)) {
    throw new StripeBillingError("Stripe subscription status is unsupported");
  }
  const quantity = Number(line.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new StripeBillingError("Stripe subscription quantity is invalid");
  // Basil and later expose the billing period on the sole licensed seat item.
  const periodEndSeconds = line.current_period_end ?? subscription.current_period_end;
  const currentPeriodEnd = Number.isSafeInteger(periodEndSeconds) && Number(periodEndSeconds) > 0
    ? new Date(Number(periodEndSeconds) * 1_000).toISOString()
    : null;
  return {
    id: text(subscription.id, "Stripe subscription id"),
    customerId: text(subscription.customer, "Stripe customer id"),
    priceId: text(price.id, "Stripe price id"),
    status,
    quantity,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    spaceId: metadataText(metadata, "xmatrix_space_id"),
    billingOwnerUserId: metadataText(metadata, "xmatrix_billing_owner_user_id"),
    ...(typeof metadata.xmatrix_checkout_intent_id === "string" && metadata.xmatrix_checkout_intent_id.trim()
      ? { checkoutIntentId: metadata.xmatrix_checkout_intent_id.trim() }
      : {}),
  };
}

import { spaceBilling } from "@xmatrix/billing";
import { Hono, type Context } from "hono";
import type { Env } from "./types";
import { billingReadSubject, agentSpaceStatus } from "./billing-read-access";
import {
  productCommandId,
  readBoundedRequestBody,
  requireAuth,
  requireHumanAuth,
  requireLiveAgentRun,
  jsonErrors, requestErrorResponse,
} from "./index-shared";
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  retrieveStripeCheckoutSession,
  retrieveStripeSubscription,
  StripeBillingError,
  stripeCheckoutReturnUrls,
  stripeCheckoutSessionFact,
  stripeSubscriptionFact,
  stripeWebhookSubscriptionId,
  verifyStripeWebhookSignature,
} from "./billing-stripe";
import { ControlError, PostgresBillingRepository } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId, postgresControlErrorResponse } from "./postgres-authority-http";

const MAX_STRIPE_WEBHOOK_BYTES = 1_048_576;
const MAX_BILLING_REQUEST_BYTES = 8_192;
type BillingContext = Context<{ Bindings: Env }>;

/** Billing facts live with their Space on its shard. */
function billingRepository(env: Env): PostgresBillingRepository {
  const shardId = postgresAuthorityShardId(env, "billing");
  return new PostgresBillingRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-billing", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }), shardId);
}

function configuredPrice(env: Env, interval: unknown): string | undefined {
  return interval === "month" ? env.STRIPE_PRO_MONTHLY_PRICE_ID?.trim() :
    interval === "year" ? env.STRIPE_PRO_ANNUAL_PRICE_ID?.trim() : undefined;
}

function billingConfigurationError() {
  return { error: "Billing is temporarily unavailable because Stripe is not configured", code: "billing_not_configured" };
}

function billingUrlResponse(c: BillingContext, field: "checkoutUrl" | "portalUrl", url: string): Response {
  return c.json({ [field]: url });
}

function billingRouteError(c: BillingContext, error: unknown): Response {
  if (error instanceof StripeBillingError) {
    return c.json(
      { error: error.message, ...(error.providerCode ? { code: error.providerCode } : {}) },
      error.retryable ? 503 : 502,
    );
  }
  return requestErrorResponse(c, error);
}

function billingAppOrigin(env: Env): string | undefined {
  const configured = env.APP_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

async function readBillingJson(request: Request): Promise<Record<string, unknown>> {
  const buffer = await readBoundedRequestBody(request, MAX_BILLING_REQUEST_BYTES);
  if (buffer === null) throw new StripeBillingError("Billing request is too large");
  const raw = new TextDecoder().decode(buffer).trim();
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new StripeBillingError("Billing request is invalid");
  }
}

function webhookEvent(value: unknown): { id: string; type: string; createdAt: string; object: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StripeBillingError("Stripe event is invalid");
  const event = value as Record<string, unknown>;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new StripeBillingError("Stripe event data is invalid");
  const object = (data as Record<string, unknown>).object;
  const created = Number(event.created);
  if (typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.type ||
      !Number.isSafeInteger(created) || created <= 0 || !object || typeof object !== "object" || Array.isArray(object)) {
    throw new StripeBillingError("Stripe event is invalid");
  }
  return { id: event.id, type: event.type, createdAt: new Date(created * 1_000).toISOString(), object: object as Record<string, unknown> };
}

async function applyStripeSubscription(
  env: Env,
  event: { id: string; type: string; createdAt: string },
  subscription: Record<string, unknown>,
  payloadDigest: string,
) {
  const facts = stripeSubscriptionFact(subscription);
  const enabledPrices = new Set([
    env.STRIPE_PRO_MONTHLY_PRICE_ID?.trim(),
    env.STRIPE_PRO_ANNUAL_PRICE_ID?.trim(),
  ].filter((value): value is string => Boolean(value)));
  if (!enabledPrices.has(facts.priceId)) {
    throw new StripeBillingError("Stripe subscription uses an unapproved price");
  }
  return billingRepository(env).applyProviderEvent({
    requestId: crypto.randomUUID(),
    commandId: `stripe-event:${event.id}`.slice(0, 200),
    providerEventId: event.id,
    eventType: event.type,
    eventCreatedAt: event.createdAt,
    payloadDigest,
    subscription: facts,
  });
}

export function registerIndexRoutesBilling(app: Hono<{ Bindings: Env }>): void {
  // A deployment without plans has nothing to read, buy or reconcile.
  if (!spaceBilling.metered) return;
  app.get("/api/spaces/:spaceId/billing", (c) => jsonErrors(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    const spaceId = c.req.param("spaceId");
    const subject = await billingReadSubject(authUser, () => requireLiveAgentRun(c.env, authUser), spaceId);
    const billing = await billingRepository(c.env).readSpaceBilling({ requestId: crypto.randomUUID(),
      spaceId, actorUserId: subject.userId });
    if (subject.agentRun) {
      return c.json(agentSpaceStatus(billing), 200, { "cache-control": "private, no-store" });
    }
    return c.json(billing);
  }));

  app.post("/api/spaces/:spaceId/billing/checkout", async (c) => {
    let checkoutIntentId: string | undefined;
    let actorUserId: string | undefined;
    try {
      const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      actorUserId = authUser.id;
      const body = await readBillingJson(c.req.raw);
      const interval = body.interval;
      const seatQuantity = body.seatQuantity;
      const priceId = configuredPrice(c.env, interval);
      const publicAppOrigin = billingAppOrigin(c.env);
      if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_WEBHOOK_SECRET || !priceId || !publicAppOrigin) return c.json(billingConfigurationError(), 503);
      const spaceId = c.req.param("spaceId");
      if (interval !== "month" && interval !== "year") return c.json({ error: "interval is invalid", code: "invalid_billing_checkout" }, 400);
      const commandId = productCommandId(c.req.raw, "billing-create-checkout-intent");
      const intent = await billingRepository(c.env).createCheckoutIntent({
        requestId: commandId, commandId, spaceId, actorUserId: authUser.id, interval, priceId,
        seatQuantity: Number(seatQuantity),
      });
      const checkoutIntent = intent.intent as Record<string, unknown> | undefined;
      if (!checkoutIntent || typeof checkoutIntent.id !== "string" || typeof checkoutIntent.seatQuantity !== "number" ||
          typeof checkoutIntent.expiresAt !== "string") {
        return c.json({ error: "Billing checkout could not be prepared" }, 503);
      }
      checkoutIntentId = checkoutIntent.id;
      const { successUrl, cancelUrl } = stripeCheckoutReturnUrls(publicAppOrigin, spaceId);
      const session = await createStripeCheckoutSession({
        secretKey: c.env.STRIPE_SECRET_KEY,
        priceId,
        seatQuantity: checkoutIntent.seatQuantity,
        successUrl,
        cancelUrl,
        spaceId,
        billingOwnerUserId: authUser.id,
        checkoutIntentId: checkoutIntent.id,
        expiresAt: checkoutIntent.expiresAt,
        allowPromotionCodes: interval === "month",
      });
      await billingRepository(c.env).recordCheckoutSession({ requestId: crypto.randomUUID(),
        commandId: `stripe-checkout-session:${session.id}`, intentId: checkoutIntent.id, sessionId: session.id });
      return billingUrlResponse(c, "checkoutUrl", session.url);
    } catch (error) {
      if (checkoutIntentId && actorUserId && error instanceof StripeBillingError) {
        const spaceId = c.req.param("spaceId");
        try {
          await billingRepository(c.env).abandonCheckoutIntent({ requestId: crypto.randomUUID(),
            commandId: `stripe-checkout-abandon:${checkoutIntentId}`, spaceId, actorUserId, intentId: checkoutIntentId });
        } catch {
          // The Stripe error is the user-facing failure. Abandon is recovery.
        }
      }
      return billingRouteError(c, error);
    }
  });

  app.post("/api/spaces/:spaceId/billing/portal", async (c) => {
    try {
      const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const publicAppOrigin = billingAppOrigin(c.env);
      if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_WEBHOOK_SECRET || !publicAppOrigin) return c.json(billingConfigurationError(), 503);
      const spaceId = c.req.param("spaceId");
      const reference = await billingRepository(c.env).portalReference({ requestId: crypto.randomUUID(),
        spaceId, actorUserId: authUser.id });
      const customerId = reference.customerId;
      if (typeof customerId !== "string") return c.json({ error: "Billing subscription is unavailable" }, 503);
      const returnUrl = new URL("/billing", publicAppOrigin);
      returnUrl.searchParams.set("space", spaceId);
      const session = await createStripeBillingPortalSession({ secretKey: c.env.STRIPE_SECRET_KEY, customerId, returnUrl: returnUrl.toString() });
      return billingUrlResponse(c, "portalUrl", session.url);
    } catch (error) {
      return billingRouteError(c, error);
    }
  });

  app.post("/api/spaces/:spaceId/billing/reconcile", async (c) => {
    try {
      const authUser = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const body = await readBillingJson(c.req.raw);
      if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_WEBHOOK_SECRET) return c.json(billingConfigurationError(), 503);
      const spaceId = c.req.param("spaceId");
      const checkoutSessionId = typeof body.checkoutSessionId === "string" && body.checkoutSessionId.trim()
        ? body.checkoutSessionId.trim()
        : null;
      if (checkoutSessionId) {
        const reference = await billingRepository(c.env).checkoutReference({ requestId: crypto.randomUUID(),
          spaceId, actorUserId: authUser.id, sessionId: checkoutSessionId });
        const intent = reference.intent as Record<string, unknown> | undefined;
        if (!intent || intent.id === undefined || intent.providerCheckoutSessionId !== checkoutSessionId) {
          return c.json({ error: "Billing checkout session is unavailable" }, 409);
        }
        const checkout = stripeCheckoutSessionFact(await retrieveStripeCheckoutSession(c.env.STRIPE_SECRET_KEY, checkoutSessionId));
        if (checkout.status !== "complete" || checkout.id !== checkoutSessionId || checkout.spaceId !== spaceId ||
            checkout.billingOwnerUserId !== authUser.id || checkout.checkoutIntentId !== intent.id) {
          return c.json({ error: "Billing checkout session could not be verified" }, 409);
        }
        const subscription = await retrieveStripeSubscription(c.env.STRIPE_SECRET_KEY, checkout.subscriptionId);
        const payloadDigest = await sha256Hex(JSON.stringify(subscription));
        const result = await applyStripeSubscription(c.env, {
          id: `checkout-reconcile:${checkoutSessionId}:${payloadDigest}`,
          type: "checkout.session.reconciled",
          createdAt: new Date().toISOString(),
        }, subscription, payloadDigest);
        return c.json({ billing: result });
      }
      const reference = await billingRepository(c.env).portalReference({ requestId: crypto.randomUUID(),
        spaceId, actorUserId: authUser.id });
      const subscriptionId = reference.subscriptionId;
      if (typeof subscriptionId !== "string") return c.json({ error: "Billing subscription is unavailable" }, 503);
      const subscription = await retrieveStripeSubscription(c.env.STRIPE_SECRET_KEY, subscriptionId);
      const facts = stripeSubscriptionFact(subscription);
      const payloadDigest = await sha256Hex(JSON.stringify(subscription));
      const event = {
        id: `reconcile:${facts.id}:${payloadDigest}`,
        type: "subscription.reconciled",
        createdAt: new Date().toISOString(),
      };
      return c.json({ billing: await applyStripeSubscription(c.env, event, subscription, payloadDigest) });
    } catch (error) {
      return billingRouteError(c, error);
    }
  });

  app.post("/api/billing/stripe/webhook", async (c) => {
    try {
      if (!c.env.STRIPE_WEBHOOK_SECRET || !c.env.STRIPE_SECRET_KEY) return c.json(billingConfigurationError(), 503);
      const buffer = await readBoundedRequestBody(c.req.raw, MAX_STRIPE_WEBHOOK_BYTES);
      if (buffer === null) return c.json({ error: "Stripe webhook body is too large" }, 413);
      const body = new TextDecoder().decode(buffer);
      await verifyStripeWebhookSignature({ body, signature: c.req.header("stripe-signature") ?? null, secret: c.env.STRIPE_WEBHOOK_SECRET });
      const event = webhookEvent(JSON.parse(body));
      if (event.type !== "customer.subscription.created" && event.type !== "customer.subscription.updated" &&
          event.type !== "customer.subscription.deleted" && event.type !== "checkout.session.completed" &&
          event.type !== "invoice.paid" && event.type !== "invoice.payment_failed") {
        return c.json({ received: true, ignored: true });
      }
      const subscriptionId = stripeWebhookSubscriptionId(event.type, event.object);
      if (typeof subscriptionId !== "string" || !subscriptionId) return c.json({ received: true, ignored: true });
      // Webhooks can be delivered out of order. Always write facts from the
      // provider's current subscription instead of the event's stale snapshot.
      const subscription = await retrieveStripeSubscription(c.env.STRIPE_SECRET_KEY, subscriptionId);
      await applyStripeSubscription(c.env, {
        ...event,
        createdAt: new Date().toISOString(),
      }, subscription, await sha256Hex(body));
      return c.json({ received: true });
    } catch (error) {
      if (error instanceof StripeBillingError) return c.json({ error: error.message }, error.retryable ? 503 : 400);
      if (error instanceof ControlError) return postgresControlErrorResponse(error);
      return c.json({ error: "Billing webhook could not be processed" }, 500);
    }
  });
}

import { spaceBilling } from "@xmatrix/billing";
import { PostgresAppleBillingRepository, PostgresBillingRepository } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import type { Hono, Context } from "hono";
import { requireAuth, requireHumanAuth, readBoundedRequestBody, productCommandId, requestErrorResponse } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import type { Env } from "./types";
import { appleBillingFact, appleSubscriptionConfig, AppleBillingError, retrieveAppleSubscription, verifyAppleNotification, type AppleSubscriptionConfig } from "./apple/subscriptions";

type BillingContext = Context<{ Bindings: Env }>;
function repositories(env: Env) {
  const db = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-hub-apple-billing", ...POSTGRES_AUTHORITY_TIMEOUTS });
  const billing = new PostgresBillingRepository(db, postgresAuthorityShardId(env, "apple-billing"));
  return { billing, apple: new PostgresAppleBillingRepository(db, billing) };
}
async function body(request: Request, limit = 8192): Promise<Record<string, unknown>> {
  const bytes = await readBoundedRequestBody(request, limit);
  if (!bytes) throw new AppleBillingError("invalid_apple_request", "Apple billing request is too large");
  try {
    const text = new TextDecoder().decode(bytes).trim();
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new AppleBillingError("invalid_apple_request", "Apple billing request is invalid"); }
}
function errorResponse(c: BillingContext, error: unknown) {
  if (error instanceof AppleBillingError) return c.json({ code: error.code, error: error.message }, error.retryable || error.code === "apple_billing_unavailable" ? 503 : 400);
  return requestErrorResponse(c, error);
}
async function reconcile(c: BillingContext, config: AppleSubscriptionConfig, originalId: unknown, environment: unknown,
  actor?: { userId: string; spaceId: string }) {
  const requestId = crypto.randomUUID();
  const { billing, apple } = repositories(c.env);
  const subscription = await retrieveAppleSubscription(config, originalId, environment);
  const binding = await apple.resolve(requestId, subscription.appAccountToken);
  if (!binding || (actor && (binding.ownerUserId !== actor.userId || binding.spaceId !== actor.spaceId))) {
    throw new AppleBillingError("apple_purchase_owner_mismatch", "This purchase is not bound to this account and Space");
  }
  if (subscription.environment === "Sandbox" && !config.sandboxSpaceIds.includes(binding.spaceId)) {
    throw new AppleBillingError("apple_sandbox_not_enabled", "Sandbox purchases are not enabled for this Space");
  }
  // Preserve the original ownership for the lifetime of the Apple transaction.
  await apple.claim(requestId, subscription.environment, subscription.originalTransactionId, binding.appAccountToken);
  const fact = appleBillingFact(subscription, binding);
  const digest = await sha256Hex(JSON.stringify({ fact, signedAt: subscription.signedAt }));
  return billing.applyProviderEvent({ requestId: `apple:${digest}`, commandId: `apple:${digest}`, providerEventId: `apple:${digest}`,
    eventType: "apple.subscription.reconciled", payloadDigest: digest, eventCreatedAt: subscription.signedAt, subscription: fact });
}

export function registerIndexRoutesAppleBilling(app: Hono<{ Bindings: Env }>): void {
  if (!spaceBilling.metered) return;
  app.get("/api/spaces/:spaceId/billing/apple", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const spaceId = c.req.param("spaceId");
      const { billing } = repositories(c.env);
      const current = await billing.readSpaceBilling({ requestId: crypto.randomUUID(), spaceId, actorUserId: user.id });
      const config = appleSubscriptionConfig(c.env.APPLE_SUBSCRIPTIONS_CONFIG);
      return c.json({ products: [{ id: config.monthlyProductId, interval: "month" }, { id: config.annualProductId, interval: "year" }],
        billing: current.billing }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/api/spaces/:spaceId/billing/apple/prepare", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const input = await body(c.req.raw);
      if (input.interval !== "month" && input.interval !== "year") throw new AppleBillingError("invalid_apple_request", "Choose a subscription period");
      const config = appleSubscriptionConfig(c.env.APPLE_SUBSCRIPTIONS_CONFIG);
      const commandId = productCommandId(c.req.raw, "apple-purchase-prepare");
      const result = await repositories(c.env).apple.prepare({ requestId: commandId,
        commandId, actorUserId: user.id, spaceId: c.req.param("spaceId"),
        interval: input.interval, productId: input.interval === "month" ? config.monthlyProductId : config.annualProductId });
      return c.json(result, 200, { "cache-control": "private, no-store" });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/api/spaces/:spaceId/billing/apple/reconcile", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const input = await body(c.req.raw);
      const reference = input.originalTransactionId === undefined && input.environment === undefined
        ? await repositories(c.env).billing.appleSubscriptionReference({ requestId: crypto.randomUUID(), actorUserId: user.id, spaceId: c.req.param("spaceId") })
        : input;
      const result = await reconcile(c, appleSubscriptionConfig(c.env.APPLE_SUBSCRIPTIONS_CONFIG), reference.originalTransactionId,
        reference.environment, { userId: user.id, spaceId: c.req.param("spaceId") });
      return c.json(result, 200, { "cache-control": "private, no-store" });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/api/billing/apple/notifications", async (c) => {
    try {
      const config = appleSubscriptionConfig(c.env.APPLE_SUBSCRIPTIONS_CONFIG);
      const input = await body(c.req.raw, 96_000);
      const notice = await verifyAppleNotification(config, input.signedPayload);
      if (notice) await reconcile(c, config, notice.transactionId, notice.environment);
      return c.json({ received: true });
    } catch (error) { return errorResponse(c, error); }
  });
}

import type { Hono, Context } from "hono";
import { spaceBilling } from "@xmatrix/billing";
import { BillingControlError, PostgresGooglePlayBillingRepository } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import { acknowledgeGooglePlaySubscription, GooglePlayBillingError, googlePlayBillingFact, googlePlaySubscriptionConfig,
  retrieveGooglePlaySubscription, validPurchaseToken, verifyGooglePlayPush, type GooglePlaySubscriptionConfig } from "./google-play/subscriptions";
import { requireAuth, requireHumanAuth, productCommandId } from "./index-shared";
import { storeBillingDatabase, storeErrorResponse as errorResponse, storeRequestBody } from "./store-billing";
import type { Env } from "./types";

type BillingContext = Context<{ Bindings: Env }>;
function repositories(env: Env) {
  const { db, billing } = storeBillingDatabase(env, "google-play");
  return { billing, play: new PostgresGooglePlayBillingRepository(db, billing) };
}
const body = (request: Request, limit = 8192) =>
  storeRequestBody(request, limit, () => new GooglePlayBillingError("invalid_google_play_request", "Google Play billing request is invalid"));

/**
 * Apply what Google says about one purchase token now. The token's obfuscated
 * account id names the owner and Space it was bought for; a signed-in caller
 * must be that owner in that Space.
 */
async function reconcile(c: BillingContext, config: GooglePlaySubscriptionConfig, purchaseToken: string,
  actor?: { userId: string; spaceId: string }) {
  const requestId = crypto.randomUUID();
  const { billing, play } = repositories(c.env);
  const subscription = await retrieveGooglePlaySubscription(config, purchaseToken);
  const binding = await play.resolve(requestId, subscription.accountToken);
  if (!binding || (actor && (binding.ownerUserId !== actor.userId || binding.spaceId !== actor.spaceId))) {
    throw new GooglePlayBillingError("google_play_purchase_owner_mismatch", "This purchase is not bound to this account and Space");
  }
  if (binding.accountDeleted) {
    if (actor) throw new GooglePlayBillingError("google_play_purchase_account_deleted", "This purchase belongs to a deleted account and cannot be restored or rebound");
    return { ignoredDeletedAccount: true };
  }
  if (subscription.environment === "Test" && !config.testSpaceIds.includes(binding.spaceId)) {
    throw new GooglePlayBillingError("google_play_test_not_enabled", "Test purchases are not enabled for this Space");
  }
  await play.claim(requestId, subscription.environment, subscription.purchaseTokenDigest, binding.accountToken);
  const fact = googlePlayBillingFact(subscription, binding);
  // Google signs no timestamp; this read is the newest authoritative fact.
  const readAt = new Date().toISOString();
  const digest = await sha256Hex(JSON.stringify({ fact, readAt }));
  const result = await billing.applyProviderEvent({ requestId: `google:${digest}`, commandId: `google:${digest}`, providerEventId: `google:${digest}`,
    eventType: "google.subscription.reconciled", payloadDigest: digest, eventCreatedAt: readAt, subscription: fact });
  // Acknowledge only after the entitlement is recorded: an unacknowledged
  // purchase is refunded by Google, so a failure here is retried by the client
  // and by Google's next notification rather than granting without a record.
  if (subscription.needsAcknowledgement) await acknowledgeGooglePlaySubscription(config, purchaseToken);
  return result;
}

export function registerIndexRoutesGooglePlayBilling(app: Hono<{ Bindings: Env }>): void {
  if (!spaceBilling.metered) return;
  app.get("/api/spaces/:spaceId/billing/google-play", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const { billing } = repositories(c.env);
      const current = await billing.readSpaceBilling({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), actorUserId: user.id });
      const config = googlePlaySubscriptionConfig(c.env.GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG);
      return c.json({ subscriptionId: config.subscriptionId, products: [
        { basePlanId: config.monthlyBasePlanId, interval: "month" }, { basePlanId: config.annualBasePlanId, interval: "year" }],
      billing: current.billing }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/api/spaces/:spaceId/billing/google-play/prepare", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const input = await body(c.req.raw);
      if (input.interval !== "month" && input.interval !== "year") throw new GooglePlayBillingError("invalid_google_play_request", "Choose a subscription period");
      const config = googlePlaySubscriptionConfig(c.env.GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG);
      const basePlanId = input.interval === "month" ? config.monthlyBasePlanId : config.annualBasePlanId;
      const commandId = productCommandId(c.req.raw, "google-play-purchase-prepare");
      const result = await repositories(c.env).play.prepare({ requestId: commandId, commandId, actorUserId: user.id,
        spaceId: c.req.param("spaceId"), interval: input.interval, productId: basePlanId });
      return c.json({ ...result, subscriptionId: config.subscriptionId, basePlanId }, 200, { "cache-control": "private, no-store" });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/api/spaces/:spaceId/billing/google-play/reconcile", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const input = await body(c.req.raw);
      const result = await reconcile(c, googlePlaySubscriptionConfig(c.env.GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG),
        validPurchaseToken(input.purchaseToken), { userId: user.id, spaceId: c.req.param("spaceId") });
      return c.json(result, 200, { "cache-control": "private, no-store" });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/api/billing/google-play/notifications", async (c) => {
    try {
      const config = googlePlaySubscriptionConfig(c.env.GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG);
      const notice = await verifyGooglePlayPush(config, c.req.header("authorization") ?? null, await body(c.req.raw, 32_768));
      if (notice) {
        try { await reconcile(c, config, notice.purchaseToken); }
        catch (error) {
          // Pub/Sub redelivers anything but success. Only a passing outage is
          // worth a retry; a purchase this Hub refuses stays refused.
          const refused = (error instanceof GooglePlayBillingError && !error.retryable) ||
            (error instanceof BillingControlError && !error.retryable && error.status < 500);
          if (!refused) throw error;
          console.warn(JSON.stringify({ event: "google_play_notification_refused", code: error.code }));
          return c.json({ received: true, ignored: error.code });
        }
      }
      return c.json({ received: true });
    } catch (error) { return errorResponse(c, error); }
  });
}

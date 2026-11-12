import { spaceBilling } from "@xmatrix/billing";
import { PostgresAppleBillingRepository } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import type { Hono, Context } from "hono";
import { requireAuth, requireHumanAuth, productCommandId } from "./index-shared";
import { storeBillingDatabase, storeErrorResponse as errorResponse, storeRequestBody } from "./store-billing";
import type { Env } from "./types";
import { appleBillingFact, appleOrganizationGroup, appleSeatGroupFact, appleSubscriptionConfig, AppleBillingError, retrieveAppleSubscription,
  verifyAppleNotification, type AppleSubscriptionConfig, type VerifiedAppleSubscription } from "./apple/subscriptions";
import { changeMembership } from "./spaces";
import type { AppleSeatGroupState } from "@xmatrix/db";

type BillingContext = Context<{ Bindings: Env }>;
function repositories(env: Env) {
  const { db, billing } = storeBillingDatabase(env, "apple");
  return { billing, apple: new PostgresAppleBillingRepository(db, billing) };
}
const body = (request: Request, limit = 8192) =>
  storeRequestBody(request, limit, () => new AppleBillingError("invalid_apple_request", "Apple billing request is invalid"));
async function reconcile(c: BillingContext, config: AppleSubscriptionConfig, originalId: unknown, environment: unknown,
  actor?: { userId: string; spaceId: string }) {
  const requestId = crypto.randomUUID();
  const { billing, apple } = repositories(c.env);
  const subscription = await retrieveAppleSubscription(config, originalId, environment);
  if (subscription.assigned) return assignedSeat(c, config, subscription, actor);
  const binding = await apple.resolve(requestId, subscription.appAccountToken);
  if (!binding || (actor && (binding.ownerUserId !== actor.userId || binding.spaceId !== actor.spaceId))) {
    throw new AppleBillingError("apple_purchase_owner_mismatch", "This purchase is not bound to this account and Space");
  }
  if (binding.accountDeleted) {
    if (actor) throw new AppleBillingError("apple_purchase_account_deleted", "This purchase belongs to a deleted account and cannot be restored or rebound");
    // The signed provider fact was verified above. Preserve immutable ownership,
    // acknowledge delivery, and never recreate entitlement for a retired identity.
    return { ignoredDeletedAccount: true };
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

/**
 * A seat an organization assigned to this person (Volume Purchasing). Its
 * group's people share one Space: the one the group's first seat was restored
 * from, which that person owns. The Space's seats are the group's active seats,
 * and a person who restores a seat joins it as a member. When Apple names no
 * organization, the seat counts toward the restorer's own Space.
 */
async function assignedSeat(c: BillingContext, config: AppleSubscriptionConfig, subscription: VerifiedAppleSubscription,
  actor?: { userId: string; spaceId: string }) {
  const requestId = crypto.randomUUID();
  const { billing, apple } = repositories(c.env);
  const seat = { environment: subscription.environment, originalTransactionId: subscription.originalTransactionId,
    productId: subscription.productId, expiresAt: subscription.expiresAt, active: subscription.active, signedAt: subscription.signedAt };
  let group: AppleSeatGroupState | null;
  if (actor) {
    const organization = await appleOrganizationGroup(config, subscription.environment, subscription.transactionId);
    const groupKey = organization ? `org:${organization}` : `user:${actor.userId}`;
    // A group starts in the Space it is first restored from; that Space must not already be paid for.
    if (!await apple.seatGroupSpace(requestId, subscription.environment, groupKey)) {
      const current = await billing.readSpaceBilling({ requestId, spaceId: actor.spaceId, actorUserId: actor.userId });
      if (current.billing.plan === "pro") throw new AppleBillingError("apple_seat_space_has_plan",
        "This Space already has a paid plan. Open a Space you own without one to start your organization's App Store seats there");
    }
    group = await apple.claimAssignedSeat(requestId, { ...seat, userId: actor.userId, spaceId: actor.spaceId, groupKey });
  } else {
    group = await apple.refreshAssignedSeat(requestId, seat);
    if (!group) return { ignoredUnclaimedSeat: true };
  }
  if (subscription.environment === "Sandbox" && !config.sandboxSpaceIds.includes(group.spaceId)) {
    throw new AppleBillingError("apple_sandbox_not_enabled", "Sandbox purchases are not enabled for this Space");
  }
  const fact = appleSeatGroupFact(subscription.environment, group);
  const digest = await sha256Hex(JSON.stringify({ fact, signedAt: subscription.signedAt, seat: subscription.originalTransactionId }));
  const result = await billing.applyProviderEvent({ requestId: `apple:${digest}`, commandId: `apple:${digest}`, providerEventId: `apple:${digest}`,
    eventType: "apple.assigned-seats.reconciled", payloadDigest: digest, eventCreatedAt: subscription.signedAt, subscription: fact });
  // Seats come first: the Space admits the new member against them.
  if (actor && subscription.active && !group.holderRole) {
    await changeMembership(c.env, { commandId: `apple-seat:${subscription.environment}:${subscription.originalTransactionId}`.slice(0, 200),
      actorUserId: group.ownerUserId, at: new Date().toISOString(), kind: "space_member_put",
      spaceId: group.spaceId, userId: actor.userId, role: "member" });
  }
  return { ...result, organizationSpaceId: group.spaceId };
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

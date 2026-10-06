import { DetailedControlError } from "./control-error.js";
import type { QueryResultRow } from "pg";
import { commandDigest as hash } from "./command-digest.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { writeOutbox } from "./outbox.js";
import { advanceSpaceControlHead } from "./space-control-head.js";
import { PostgresEntitySpaceDirectory } from "./entity-directory.js";
import { WritableSpacePlacements, type SpacePlacement } from "./placement.js";
import { commandFields } from "./command-fields.js";
import { readSpaceCommandReplay, storeSpaceCommandReplay } from "./command-replay.js";


const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CHECKOUT_TTL_MS = 60 * 60 * 1_000;
const WEBHOOK_TTL_MS = 35 * 24 * 60 * 60 * 1_000;
const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

const STRIPE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "incomplete", "incomplete_expired",
  "unpaid", "canceled", "paused"] as const;

/** A Stripe subscription as a provider event reports it, keyed to the Space it bills. */
export interface StripeSubscriptionFact {
  id: string;
  customerId: string;
  priceId: string;
  status: typeof STRIPE_SUBSCRIPTION_STATUSES[number];
  quantity: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  spaceId: string;
  billingOwnerUserId: string;
  checkoutIntentId?: string;
}

export class BillingControlError extends DetailedControlError {
  override name = "BillingControlError";
}

const { text } = commandFields((field) =>
  new BillingControlError("invalid_billing_request", 400, `${field} is invalid`));

function replay(
  tx: DatabaseTransaction, spaceId: string, commandId: string, kind: string, requestDigest: string,
): Promise<Record<string, unknown> | null> {
  return readSpaceCommandReplay(tx, "billing_idempotency_read_v1",
    { spaceId, commandId, commandKind: kind, requestDigest },
    () => new BillingControlError("idempotency_conflict", 409, "command id was reused"));
}

async function commit(
  tx: DatabaseTransaction,
  input: { spaceId: string; commandId: string; kind: string; requestDigest: string;
    result: Record<string, unknown>; aggregateId: string; now: string },
): Promise<void> {
  const sequence = await advanceSpaceControlHead(tx, {
    name: "billing_head_advance_v1", spaceId: input.spaceId, at: input.now,
  });
  if (sequence === undefined) throw new BillingControlError(
    "space_control_head_missing", 500, "Space control head is unavailable",
  );
  await writeOutbox(tx, {
    name: "billing_outbox_v1",
    outboxId: `space-control:${input.spaceId}:${sequence}`,
    spaceId: input.spaceId,
    topic: "space-control",
    aggregateKind: "billing",
    aggregateId: input.aggregateId,
    aggregateSequence: sequence,
    payload: input.result,
    at: input.now,
  });
  await storeSpaceCommandReplay(tx, "billing_idempotency_write_v1", { ...input, commandKind: input.kind,
    commitSequence: sequence, at: input.now, ttlMs: IDEMPOTENCY_TTL_MS });
}

/** The fields every request a Space's owner makes about its billing carries. */
function ownerRequest(input: { requestId: string; spaceId: string; actorUserId: string }) {
  return { requestId: text(input.requestId, "requestId", 200), spaceId: text(input.spaceId, "spaceId"),
    actorUserId: text(input.actorUserId, "actorUserId") };
}

async function requireOwner(tx: DatabaseTransaction, spaceId: string, userId: string): Promise<void> {
  const rows = await tx.query({
    name: "billing_require_owner_v1",
    text: `SELECT user_id FROM data.space_members
      WHERE space_id = $1 AND user_id = $2 AND role = 'owner' LIMIT 1`,
    values: [spaceId, userId], maxRows: 1,
  });
  if (!rows[0]) throw new BillingControlError(
    "billing_owner_required", 403, "Space owner permission is required for billing",
  );
}

function subscriptionEntitled(row: QueryResultRow | undefined, now: number): boolean {
  return row?.status === "active" || row?.status === "trialing" ||
    (row?.status === "past_due" && row.grace_until &&
      new Date(row.grace_until as Date | string).getTime() > now);
}

async function summary(
  tx: DatabaseTransaction, spaceId: string, actorUserId: string,
): Promise<Record<string, unknown>> {
  const [members, subscriptions, usage, seats] = await Promise.all([
    tx.query<QueryResultRow & { role: string }>({
      name: "billing_summary_member_v1",
      text: "SELECT role FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
      values: [spaceId, actorUserId], maxRows: 1,
    }),
    tx.query<QueryResultRow>({
      name: "billing_summary_subscription_v1",
      text: "SELECT * FROM data.space_billing_subscriptions WHERE space_id = $1 LIMIT 1",
      values: [spaceId], maxRows: 1,
    }),
    tx.query<QueryResultRow>({
      name: "billing_summary_usage_v1",
      text: "SELECT free_message_count FROM data.space_billing_usage WHERE space_id = $1 LIMIT 1",
      values: [spaceId], maxRows: 1,
    }),
    tx.query<QueryResultRow & { count: string | number }>({
      name: "billing_summary_seats_v1",
      text: `SELECT COUNT(*) AS count FROM data.space_members
        WHERE space_id = $1 AND role IN ('owner','admin','member')`,
      values: [spaceId], maxRows: 1,
    }),
  ]);
  const member = members[0];
  if (!member) throw new BillingControlError("forbidden", 403, "Space membership is required");
  const subscription = subscriptions[0];
  const now = Date.now();
  const entitled = subscriptionEntitled(subscription, now);
  const used = Number(seats[0]?.count ?? 0);
  const limit = entitled ? Number(subscription!.seat_quantity) : 3;
  const acceptedMessages = Number(usage[0]?.free_message_count ?? 0);
  const graceReadOnly = subscription?.status === "past_due" && subscription.grace_until &&
    new Date(subscription.grace_until as Date | string).getTime() > now;
  return {
    plan: entitled ? "pro" : "free",
    subscription: subscription ? {
      status: subscription.status, seatQuantity: Number(subscription.seat_quantity),
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      ...(subscription.grace_until ? { graceUntil: subscription.grace_until } : {}),
      access: graceReadOnly ? "read_only" : "full",
    } : null,
    seats: { used, limit },
    ...(used > limit ? { seatAdjustmentRequired: true } : {}),
    freeUsage: { acceptedMessages, limit: 500, remaining: Math.max(0, 500 - acceptedMessages) },
    canManage: member.role === "owner",
  };
}

export class PostgresBillingRepository {
  private readonly spaces: WritableSpacePlacements;
  private readonly entityDirectory: PostgresEntitySpaceDirectory;

  constructor(private readonly database: AuthorityDatabase, shardId: string) {
    if (database.cacheMode !== "disabled") throw new BillingControlError(
      "cached_authority_forbidden", 500, "Billing authority requires uncached PostgreSQL",
    );
    text(shardId, "shardId");
    this.spaces = new WritableSpacePlacements(database, () =>
      new BillingControlError("space_placement_unavailable", 503, "Space placement is unavailable", true));
    this.entityDirectory = new PostgresEntitySpaceDirectory(database);
  }

  private async publishCheckoutRoute(
    requestId: string, placement: SpacePlacement, intentId: string,
  ): Promise<void> {
    const rows = await this.spaces.transaction(requestId, "billing-checkout.directory-source",
      placement, (tx) => tx.query<QueryResultRow & { route_version: string | number; updated_at: string }>({
      name: "billing_checkout_route_source_v1",
      text: `SELECT head.commit_sequence AS route_version,head.updated_at
        FROM data.space_billing_checkout_intents checkout
        JOIN data.space_control_heads head ON head.space_id = checkout.space_id
        WHERE checkout.space_id = $1 AND checkout.checkout_intent_id = $2 LIMIT 1`,
      values: [placement.spaceId, intentId], maxRows: 1,
    }));
    if (!rows[0]) throw new BillingControlError(
      "entity_directory_source_incomplete", 503, "Billing directory source is incomplete", true,
    );
    await this.entityDirectory.publish({
      requestId, operation: "billing-checkout.directory-publish",
    }, {
      kind: "billing-checkout", entityId: intentId, spaceId: placement.spaceId,
      shardId: placement.shardId, placementEpoch: placement.placementEpoch,
      entityVersion: 1, routeVersion: Number(rows[0].route_version), state: "active",
      updatedAt: rows[0].updated_at,
    });
  }

  async readSpaceBilling(input: { requestId: string; spaceId: string; actorUserId: string }) {
    const { requestId, spaceId, actorUserId } = ownerRequest(input);
    return this.spaces.transaction(requestId, "billing.read", spaceId,
      async (tx) => ({ billing: await summary(tx, spaceId, actorUserId) }));
  }

  async portalReference(input: { requestId: string; spaceId: string; actorUserId: string }) {
    const { requestId, spaceId, actorUserId } = ownerRequest(input);
    return this.spaces.transaction(requestId, "billing.portal-reference", spaceId, async (tx) => {
      await requireOwner(tx, spaceId, actorUserId);
      const rows = await tx.query<QueryResultRow>({
        name: "billing_portal_reference_v1",
        text: `SELECT provider_customer_id,provider_subscription_id
          FROM data.space_billing_subscriptions WHERE space_id = $1 LIMIT 1`,
        values: [spaceId], maxRows: 1,
      });
      if (!rows[0]) throw new BillingControlError(
        "billing_subscription_not_found", 404, "This Space has no billing subscription",
      );
      return { customerId: rows[0].provider_customer_id,
        subscriptionId: rows[0].provider_subscription_id };
    });
  }

  async checkoutReference(input: {
    requestId: string; spaceId: string; actorUserId: string; sessionId: string;
  }) {
    const { requestId, spaceId, actorUserId } = ownerRequest(input);
    const sessionId = text(input.sessionId, "sessionId");
    return this.spaces.transaction(requestId, "billing.checkout-reference", spaceId, async (tx) => {
      await requireOwner(tx, spaceId, actorUserId);
      const rows = await tx.query<QueryResultRow>({
        name: "billing_checkout_reference_v1",
        text: `SELECT checkout_intent_id,billing_interval,seat_quantity,expires_at,
            provider_checkout_session_id FROM data.space_billing_checkout_intents
          WHERE space_id = $1 AND billing_owner_user_id = $2
            AND provider_checkout_session_id = $3 AND status IN ('created','completed') LIMIT 1`,
        values: [spaceId, actorUserId, sessionId], maxRows: 1,
      });
      if (!rows[0]) throw new BillingControlError(
        "billing_checkout_not_found", 404, "Billing checkout session is unavailable",
      );
      return { intent: this.intentView(rows[0], spaceId) };
    });
  }

  async createCheckoutIntent(input: {
    requestId: string; commandId: string; spaceId: string; actorUserId: string;
    interval: "month" | "year"; priceId: string; seatQuantity: number;
  }) {
    const { requestId, spaceId, actorUserId } = ownerRequest(input);
    const commandId = text(input.commandId, "commandId");
    const priceId = text(input.priceId, "priceId");
    if (!Number.isSafeInteger(input.seatQuantity) || input.seatQuantity < 1 ||
        input.seatQuantity > 99 || (input.interval !== "month" && input.interval !== "year")) {
      throw new BillingControlError("invalid_billing_checkout", 400, "Billing checkout inputs are invalid");
    }
    const requestDigest = await hash(input);
    const now = new Date().toISOString();
    const placement = await this.spaces.resolve(requestId, "billing.checkout.create", spaceId);
    const result = await this.spaces.transaction(requestId, "billing.checkout.create", placement, async (tx) => {
      const prior = await replay(tx, spaceId, commandId, "billing-create-checkout-intent", requestDigest);
      if (prior) return prior;
      await requireOwner(tx, spaceId, actorUserId);
      const subscriptions = await tx.query<QueryResultRow>({
        name: "billing_checkout_subscription_v1",
        text: "SELECT status,grace_until FROM data.space_billing_subscriptions WHERE space_id = $1 FOR UPDATE",
        values: [spaceId], maxRows: 1,
      });
      if (subscriptionEntitled(subscriptions[0], Date.parse(now))) throw new BillingControlError(
        "billing_subscription_active", 409, "This Space already has an active Pro subscription",
      );
      const seats = await tx.query<QueryResultRow & { count: string | number }>({
        name: "billing_checkout_seats_v1",
        text: `SELECT COUNT(*) AS count FROM data.space_members
          WHERE space_id = $1 AND role IN ('owner','admin','member')`,
        values: [spaceId], maxRows: 1,
      });
      const used = Number(seats[0]?.count ?? 0);
      if (input.seatQuantity < used) throw new BillingControlError(
        "billing_seat_quantity_too_low", 409,
        "Choose at least as many seats as current billable members", false, { usedSeats: used },
      );
      await tx.query({
        name: "billing_checkout_expired_cleanup_v1",
        text: `DELETE FROM data.space_billing_checkout_intents WHERE checkout_intent_id IN (
          SELECT checkout_intent_id FROM data.space_billing_checkout_intents
          WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100)`,
        values: [now], maxRows: 100,
      });
      const existing = await tx.query<QueryResultRow>({
        name: "billing_checkout_active_v1",
        text: `SELECT checkout_intent_id,billing_owner_user_id,billing_interval,provider_price_id,
            seat_quantity,status,provider_checkout_session_id,expires_at
          FROM data.space_billing_checkout_intents
          WHERE space_id = $1 AND status IN ('pending','created') AND expires_at > $2
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        values: [spaceId, now], maxRows: 1,
      });
      const row = existing[0];
      let result: Record<string, unknown>;
      let intentId: string;
      if (row) {
        if (row.billing_owner_user_id !== actorUserId || row.billing_interval !== input.interval ||
            row.provider_price_id !== priceId || Number(row.seat_quantity) !== input.seatQuantity) {
          throw new BillingControlError(
            "billing_checkout_in_progress", 409,
            "A checkout is already in progress for this Space", false,
            { spaceId, checkoutIntentId: row.checkout_intent_id },
          );
        }
        intentId = String(row.checkout_intent_id);
        result = { intent: this.intentView(row, spaceId), reused: true };
      } else {
        intentId = crypto.randomUUID();
        const expiresAt = new Date(Date.parse(now) + CHECKOUT_TTL_MS).toISOString();
        await tx.query({
          name: "billing_checkout_insert_v1",
          text: `INSERT INTO data.space_billing_checkout_intents
            (checkout_intent_id,space_id,billing_owner_user_id,plan,billing_interval,
             provider_price_id,seat_quantity,status,provider_checkout_session_id,
             created_at,expires_at,completed_at,updated_at)
            VALUES ($1,$2,$3,'pro',$4,$5,$6,'pending',NULL,$7,$8,NULL,$7)`,
          values: [intentId, spaceId, actorUserId, input.interval, priceId,
            input.seatQuantity, now, expiresAt], maxRows: 0,
        });
        result = { intent: { id: intentId, spaceId, interval: input.interval,
          seatQuantity: input.seatQuantity, expiresAt } };
      }
      await commit(tx, { spaceId, commandId, kind: "billing-create-checkout-intent",
        requestDigest, result, aggregateId: intentId, now });
      return result;
    });
    const intent = result.intent && typeof result.intent === "object"
      ? result.intent as Record<string, unknown> : null;
    await this.publishCheckoutRoute(requestId, placement, text(intent?.id, "intent.id"));
    return result;
  }

  async recordCheckoutSession(input: {
    requestId: string; commandId: string; intentId: string; sessionId: string;
  }) {
    const requestId = text(input.requestId, "requestId", 200);
    const commandId = text(input.commandId, "commandId");
    const intentId = text(input.intentId, "intentId");
    const sessionId = text(input.sessionId, "sessionId");
    const route = await this.entityDirectory.resolve(
      { requestId, operation: "billing.checkout.locate" }, "billing-checkout", intentId,
    );
    const located = route ? null : await this.database.transaction(
      { requestId, operation: "billing.checkout.locate-legacy" },
      (tx) => tx.query<QueryResultRow & { space_id: string }>({
        name: "billing_checkout_locate_legacy_v1",
        text: `SELECT space_id FROM data.space_billing_checkout_intents
          WHERE checkout_intent_id = $1 LIMIT 1`, values: [intentId], maxRows: 1,
      }),
    );
    const spaceId = route?.spaceId ?? located?.[0]?.space_id;
    if (!spaceId) throw new BillingControlError(
      "billing_checkout_expired", 409, "Billing checkout session is no longer active",
    );
    const requestDigest = await hash(input);
    const now = new Date().toISOString();
    return this.spaces.transaction(requestId, "billing.checkout.record", spaceId, async (tx) => {
      const prior = await replay(tx, spaceId, commandId, "billing-record-checkout-session", requestDigest);
      if (prior) return prior;
      const rows = await tx.query<QueryResultRow>({
        name: "billing_checkout_record_lock_v1",
        text: `SELECT status,expires_at,provider_checkout_session_id
          FROM data.space_billing_checkout_intents WHERE checkout_intent_id = $1 FOR UPDATE`,
        values: [intentId], maxRows: 1,
      });
      const intent = rows[0];
      if (!intent || new Date(intent.expires_at as Date | string).getTime() <= Date.parse(now)) {
        throw new BillingControlError(
          "billing_checkout_expired", 409, "Billing checkout session is no longer active",
        );
      }
      let result: Record<string, unknown>;
      if (intent.status === "created" && intent.provider_checkout_session_id === sessionId) {
        result = { recorded: true, replayed: true };
      } else {
        if (intent.status !== "pending") throw new BillingControlError(
          "billing_checkout_conflict", 409,
          "Billing checkout session is already bound to another attempt",
        );
        await tx.query({
          name: "billing_checkout_record_v1",
          text: `UPDATE data.space_billing_checkout_intents SET
            provider_checkout_session_id = $2,status = 'created',updated_at = $3
            WHERE checkout_intent_id = $1`,
          values: [intentId, sessionId, now], maxRows: 0,
        });
        result = { recorded: true };
      }
      await commit(tx, { spaceId, commandId, kind: "billing-record-checkout-session",
        requestDigest, result, aggregateId: intentId, now });
      return result;
    });
  }

  async abandonCheckoutIntent(input: {
    requestId: string; commandId: string; spaceId: string; actorUserId: string; intentId: string;
  }) {
    const { requestId, spaceId, actorUserId } = ownerRequest(input);
    const commandId = text(input.commandId, "commandId");
    const intentId = text(input.intentId, "intentId");
    const requestDigest = await hash(input);
    const now = new Date().toISOString();
    return this.spaces.transaction(requestId, "billing.checkout.abandon", spaceId, async (tx) => {
      const prior = await replay(tx, spaceId, commandId, "billing-abandon-checkout-intent", requestDigest);
      if (prior) return prior;
      await requireOwner(tx, spaceId, actorUserId);
      const rows = await tx.query<QueryResultRow>({
        name: "billing_checkout_abandon_lock_v1",
        text: `SELECT space_id,billing_owner_user_id,status
          FROM data.space_billing_checkout_intents WHERE checkout_intent_id = $1 FOR UPDATE`,
        values: [intentId], maxRows: 1,
      });
      const intent = rows[0];
      if (!intent || intent.space_id !== spaceId) throw new BillingControlError(
        "billing_checkout_expired", 409, "Billing checkout session is no longer active",
      );
      if (intent.billing_owner_user_id !== actorUserId) throw new BillingControlError(
        "billing_owner_required", 403, "Space owner permission is required for billing",
      );
      const active = intent.status === "pending" || intent.status === "created";
      if (active) await tx.query({
        name: "billing_checkout_abandon_v1",
        text: `UPDATE data.space_billing_checkout_intents SET status = 'expired',
          expires_at = $2,updated_at = $2 WHERE checkout_intent_id = $1`,
        values: [intentId, now], maxRows: 0,
      });
      const result = active ? { abandoned: true } : { abandoned: false, replayed: true };
      await commit(tx, { spaceId, commandId, kind: "billing-abandon-checkout-intent",
        requestDigest, result, aggregateId: intentId, now });
      return result;
    });
  }

  async applyProviderEvent(input: {
    requestId: string; commandId: string; providerEventId: string; eventType: string;
    payloadDigest: string; eventCreatedAt: string;
    subscription: StripeSubscriptionFact;
  }) {
    const requestId = text(input.requestId, "requestId", 200);
    const commandId = text(input.commandId, "commandId");
    const providerEventId = text(input.providerEventId, "providerEventId");
    const eventType = text(input.eventType, "eventType", 160);
    const payloadDigest = text(input.payloadDigest, "payloadDigest", 128);
    const eventCreatedAt = text(input.eventCreatedAt, "eventCreatedAt", 64);
    const subscription = input.subscription;
    const spaceId = text(subscription.spaceId, "subscription.spaceId");
    const ownerUserId = text(subscription.billingOwnerUserId, "subscription.billingOwnerUserId");
    const subscriptionId = text(subscription.id, "subscription.id");
    const customerId = text(subscription.customerId, "subscription.customerId");
    const priceId = text(subscription.priceId, "subscription.priceId");
    if (!/^[0-9a-f]{64}$/u.test(payloadDigest) || !Number.isFinite(Date.parse(eventCreatedAt)) ||
        !STRIPE_SUBSCRIPTION_STATUSES.includes(subscription.status) ||
        !Number.isSafeInteger(subscription.quantity) || subscription.quantity < 1 ||
        subscription.quantity > 99) {
      throw new BillingControlError("invalid_billing_event", 400, "Billing provider event is invalid");
    }
    const spaces = await this.database.transaction(
      { requestId, operation: "billing.provider-event.locate" },
      (tx) => tx.query({
        name: "billing_provider_event_space_v1",
        text: "SELECT space_id FROM data.spaces WHERE space_id = $1 LIMIT 1",
        values: [spaceId], maxRows: 1,
      }),
    );
    if (!spaces[0]) return { ignoredMissingSpace: true };
    const requestDigest = await hash(input);
    const now = new Date().toISOString();
    return this.spaces.transaction(requestId, "billing.provider-event.apply", spaceId, async (tx) => {
      const priorCommand = await replay(
        tx, spaceId, commandId, "billing-apply-provider-event", requestDigest,
      );
      if (priorCommand) return priorCommand;
      const owners = await tx.query<QueryResultRow & { role: string }>({
        name: "billing_provider_event_owner_v1",
        text: "SELECT role FROM data.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 1",
        values: [spaceId, ownerUserId], maxRows: 1,
      });
      if (owners[0]?.role !== "owner") throw new BillingControlError(
        "invalid_billing_event", 400,
        "Billing subscription metadata is not bound to the current Space owner",
      );
      const receipts = await tx.query<QueryResultRow>({
        name: "billing_provider_event_receipt_v1",
        text: `SELECT payload_digest FROM data.space_billing_webhook_events
          WHERE space_id = $1 AND provider_event_id = $2 LIMIT 1`,
        values: [spaceId, providerEventId], maxRows: 1,
      });
      if (receipts[0]) {
        if (receipts[0].payload_digest !== payloadDigest) throw new BillingControlError(
          "billing_event_replay_mismatch", 409,
          "Billing event id was replayed with different contents",
        );
        const result = { replayed: true, ...(await summary(tx, spaceId, ownerUserId)) };
        await commit(tx, { spaceId, commandId, kind: "billing-apply-provider-event",
          requestDigest, result, aggregateId: providerEventId, now });
        return result;
      }
      await tx.query({
        name: "billing_provider_event_cleanup_v1",
        text: `DELETE FROM data.space_billing_webhook_events WHERE (space_id,provider_event_id) IN (
          SELECT space_id,provider_event_id FROM data.space_billing_webhook_events
          WHERE expires_at <= $1 ORDER BY expires_at LIMIT 100)`,
        values: [now], maxRows: 100,
      });
      const existingRows = await tx.query<QueryResultRow>({
        name: "billing_provider_event_subscription_lock_v1",
        text: "SELECT * FROM data.space_billing_subscriptions WHERE space_id = $1 FOR UPDATE",
        values: [spaceId], maxRows: 1,
      });
      const existing = existingRows[0];
      const incomingCanEntitle = ["active", "trialing", "past_due"].includes(subscription.status);
      if (existing && existing.provider_subscription_id !== subscriptionId &&
          subscriptionEntitled(existing, Date.parse(now)) && incomingCanEntitle) {
        throw new BillingControlError(
          "billing_subscription_conflict", 409,
          "This Space already has a different active billing subscription",
        );
      }
      const stale = existing &&
        new Date(existing.provider_event_created_at as Date | string).getTime() > Date.parse(eventCreatedAt);
      const expiresAt = new Date(Date.parse(now) + WEBHOOK_TTL_MS).toISOString();
      await tx.query({
        name: "billing_provider_event_receipt_insert_v1",
        text: `INSERT INTO data.space_billing_webhook_events
          (space_id,provider_event_id,event_type,payload_digest,outcome,expires_at,processed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [spaceId, providerEventId, eventType, payloadDigest,
          stale ? "ignored_stale" : "processed", expiresAt, now], maxRows: 0,
      });
      let result: Record<string, unknown>;
      if (stale) {
        result = { ignoredStale: true, ...(await summary(tx, spaceId, ownerUserId)) };
      } else {
        // Grace is anchored to the first past_due event; later past_due snapshots keep the same end.
        const priorGrace = existing && existing.provider_subscription_id === subscriptionId &&
          existing.status === "past_due" && existing.grace_until
          ? new Date(existing.grace_until as Date | string).toISOString() : null;
        const graceUntil = subscription.status !== "past_due" ? null
          : priorGrace ?? new Date(Date.parse(now) + PAST_DUE_GRACE_MS).toISOString();
        await tx.query({
          name: "billing_provider_event_subscription_upsert_v1",
          text: `INSERT INTO data.space_billing_subscriptions
            (space_id,billing_owner_user_id,provider_customer_id,provider_subscription_id,
             provider_price_id,plan,status,seat_quantity,current_period_end,cancel_at_period_end,
             grace_until,provider_event_created_at,version,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,'pro',$6,$7,$8,$9,$10,$11,1,$12,$12)
            ON CONFLICT (space_id) DO UPDATE SET
              billing_owner_user_id = EXCLUDED.billing_owner_user_id,
              provider_customer_id = EXCLUDED.provider_customer_id,
              provider_subscription_id = EXCLUDED.provider_subscription_id,
              provider_price_id = EXCLUDED.provider_price_id,status = EXCLUDED.status,
              seat_quantity = EXCLUDED.seat_quantity,current_period_end = EXCLUDED.current_period_end,
              cancel_at_period_end = EXCLUDED.cancel_at_period_end,
              grace_until = EXCLUDED.grace_until,
              provider_event_created_at = EXCLUDED.provider_event_created_at,
              version = data.space_billing_subscriptions.version + 1,
              updated_at = EXCLUDED.updated_at`,
          values: [spaceId, ownerUserId, customerId, subscriptionId, priceId,
            subscription.status, subscription.quantity, subscription.currentPeriodEnd,
            subscription.cancelAtPeriodEnd, graceUntil, eventCreatedAt, now], maxRows: 0,
        });
        if (subscription.checkoutIntentId) await tx.query({
          name: "billing_provider_event_checkout_complete_v1",
          text: `UPDATE data.space_billing_checkout_intents SET status = 'completed',
            completed_at = $3,updated_at = $3 WHERE checkout_intent_id = $1 AND space_id = $2`,
          values: [text(subscription.checkoutIntentId, "subscription.checkoutIntentId"),
            spaceId, now], maxRows: 0,
        });
        result = { applied: true, ...(await summary(tx, spaceId, ownerUserId)) };
      }
      await commit(tx, { spaceId, commandId, kind: "billing-apply-provider-event",
        requestDigest, result, aggregateId: providerEventId, now });
      return result;
    });
  }

  private intentView(row: QueryResultRow, spaceId: string) {
    return { id: row.checkout_intent_id, spaceId, interval: row.billing_interval,
      seatQuantity: Number(row.seat_quantity), expiresAt: row.expires_at,
      ...(row.provider_checkout_session_id
        ? { providerCheckoutSessionId: row.provider_checkout_session_id } : {}) };
  }
}

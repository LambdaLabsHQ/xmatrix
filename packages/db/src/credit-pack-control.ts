import type { QueryResultRow } from "pg";
import { spaceBilling, type SpaceBillingPolicy } from "@xmatrix/billing";
import type { AuthorityDatabase } from "./contracts.js";
import { BillingControlError, commitBillingMutation } from "./billing-control.js";
import { WritableSpacePlacements } from "./placement.js";
import { commandFields } from "./command-fields.js";

const { text } = commandFields(field => new BillingControlError(
  "invalid_credit_purchase", 400, `${field} is invalid`));
import { commandDigest } from "./command-digest.js";

const PRICE_CENTS = 1_000;

export interface CreditPackPayment {
  purchaseId: string; spaceId: string; ownerUserId: string; sessionId: string;
  amountCents: number; currency: string;
}

/** Space-owned purchases and permanent settlement receipts, on its current shard. */
export class PostgresCreditPackRepository {
  private readonly spaces: WritableSpacePlacements;
  constructor(database: AuthorityDatabase, shardId: string, private readonly billing: SpaceBillingPolicy = spaceBilling) {
    if (database.cacheMode !== "disabled") throw new BillingControlError(
      "cached_authority_forbidden", 500, "Credit purchases require uncached PostgreSQL");
    text(shardId, "shardId");
    this.spaces = new WritableSpacePlacements(database, () => new BillingControlError(
      "space_placement_unavailable", 503, "Space placement is unavailable", true));
  }

  async create(input: { requestId: string; commandId: string; spaceId: string; actorUserId: string }) {
    const spaceId = text(input.spaceId, "spaceId");
    const owner = text(input.actorUserId, "actorUserId");
    const commandId = text(input.commandId, "commandId");
    const credits = this.billing.credits?.packCredits;
    if (!credits) throw new BillingControlError("credits_unavailable", 404, "Credit packs are unavailable");
    return this.spaces.transaction(input.requestId, "billing.credit-pack.create", spaceId, async tx => {
      // Serializes purchase creation with membership changes and Space deletion.
      await tx.query({ name: "credit_pack_owner_lock_v1", text: `SELECT s.space_id FROM data.spaces s
        JOIN data.space_members m ON m.space_id=s.space_id
        WHERE s.space_id=$1 AND m.user_id=$2 AND m.role='owner' FOR UPDATE OF s`,
      values: [spaceId, owner], maxRows: 1 }).then(rows => {
        if (!rows[0]) throw new BillingControlError("billing_owner_required", 403, "Space owner permission is required for billing");
      });
      const subscription = await tx.query({ name: "credit_pack_subscription_v1", text: `SELECT space_id
        FROM data.space_billing_subscriptions WHERE space_id=$1 AND status IN ('active','trialing')
          AND (billing_provider<>'apple' OR current_period_end>now()) LIMIT 1`, values: [spaceId], maxRows: 1 });
      if (!subscription[0]) throw new BillingControlError("credit_pack_pro_required", 409, "Credit packs require an active Pro plan");
      const existing = (await tx.query({ name: "credit_pack_existing_v1", text: `SELECT * FROM data.space_credit_purchases
        WHERE space_id=$1 AND (command_id=$2 OR (status IN ('pending','created') AND expires_at>now()))
        ORDER BY (command_id=$2) DESC,created_at DESC LIMIT 1`, values: [spaceId, commandId], maxRows: 1 }))[0];
      if (existing) {
        if (existing.owner_user_id !== owner || existing.status === "completed" ||
          new Date(existing.expires_at as string | Date).getTime() <= Date.now()) throw new BillingControlError(
            "credit_purchase_expired", 409, "Start a new credit pack checkout");
        return existing;
      }
      const created = (await tx.query({ name: "credit_pack_create_v1", text: `INSERT INTO data.space_credit_purchases
        (purchase_id,space_id,owner_user_id,command_id,credits,amount_cents,currency,status,expires_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'usd','pending',now()+interval '1 hour',now(),now()) RETURNING *`,
      values: [crypto.randomUUID(), spaceId, owner, commandId, credits, PRICE_CENTS], maxRows: 1 }))[0];
      await commitBillingMutation(tx, { spaceId, commandId: `credit-pack-create:${created.purchase_id}`,
        kind: "credit-pack-create", requestDigest: await commandDigest({ spaceId, owner, commandId }),
        result: { purchaseId: created.purchase_id, credits, amountCents: PRICE_CENTS },
        aggregateId: String(created.purchase_id), now: new Date().toISOString() });
      return created;
    });
  }

  async record(input: { requestId: string; spaceId: string; purchaseId: string; sessionId: string }) {
    return this.spaces.transaction(input.requestId, "billing.credit-pack.record", text(input.spaceId, "spaceId"), async tx => {
      const rows = await tx.query({ name: "credit_pack_record_v1", text: `UPDATE data.space_credit_purchases
        SET provider_session_id=$3,status=CASE WHEN status='completed' THEN status ELSE 'created' END,updated_at=now()
        WHERE space_id=$1 AND purchase_id=$2 AND (provider_session_id IS NULL OR provider_session_id=$3)
        RETURNING purchase_id`, values: [input.spaceId, text(input.purchaseId, "purchaseId"), text(input.sessionId, "sessionId")], maxRows: 1 });
      if (!rows[0]) throw new BillingControlError("credit_purchase_conflict", 409, "Credit checkout could not be recorded");
    });
  }

  /** Called only with a freshly retrieved, verified paid Stripe Checkout Session. */
  async settle(requestId: string, payment: CreditPackPayment) {
    const spaceId = text(payment.spaceId, "spaceId");
    const purchaseId = text(payment.purchaseId, "purchaseId");
    const sessionId = text(payment.sessionId, "sessionId");
    return this.spaces.transaction(requestId, "billing.credit-pack.settle", spaceId, async tx => {
      const row = (await tx.query<QueryResultRow>({ name: "credit_pack_settlement_lock_v1", text: `SELECT *
        FROM data.space_credit_purchases WHERE space_id=$1 AND purchase_id=$2 FOR UPDATE`,
      values: [spaceId, purchaseId], maxRows: 1 }))[0];
      if (!row || row.owner_user_id !== payment.ownerUserId || Number(row.amount_cents) !== payment.amountCents ||
        row.currency !== payment.currency || (row.provider_session_id && row.provider_session_id !== sessionId)) {
        throw new BillingControlError("credit_purchase_mismatch", 409, "Payment does not match its credit purchase");
      }
      if (row.status === "completed") return { credited: false, replayed: true };
      // Counter and permanent receipt commit together. No month reset here:
      // the charging statement owns rollover and preserves pack_balance.
      await tx.query({ name: "credit_pack_balance_add_v1", text: `INSERT INTO data.space_credit_state AS s
        (space_id,period_start,pack_balance,created_at,updated_at)
        VALUES ($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$2,now(),now())
        ON CONFLICT (space_id) DO UPDATE SET pack_balance=s.pack_balance+EXCLUDED.pack_balance,
          version=s.version+1,updated_at=now()`, values: [spaceId, row.credits], maxRows: 0 });
      await tx.query({ name: "credit_pack_settled_v1", text: `UPDATE data.space_credit_purchases
        SET status='completed',provider_session_id=$3,updated_at=now() WHERE space_id=$1 AND purchase_id=$2`,
      values: [spaceId, purchaseId, sessionId], maxRows: 0 });
      const result = { credited: true, credits: Number(row.credits) };
      await commitBillingMutation(tx, { spaceId, commandId: `credit-pack-paid:${purchaseId}`,
        kind: "credit-pack-paid", requestDigest: await commandDigest(payment),
        result: { ...result, purchaseId }, aggregateId: purchaseId, now: new Date().toISOString() });
      return result;
    });
  }
}

import { spaceBilling, type BillingNotice, type CreditAllocation, type PaidCallKind,
  type SpaceBillingPolicy } from "@xmatrix/billing";
import type { AuthorityDatabase } from "./contracts.js";
import { BillingControlError, commitBillingMutation } from "./billing-control.js";
import { commandDigest } from "./command-digest.js";
import { commandFields } from "./command-fields.js";
import { WritableSpacePlacements } from "./placement.js";
import { DatabaseCommitUnknownError } from "./errors.js";

const { text } = commandFields(field => new BillingControlError("invalid_paid_call", 400, `${field} is invalid`));

export interface PaidCallReceipt {
  callId: string;
  reservedCredits: number;
  chargedCredits: number;
  remainingCredits: number;
  replayed: boolean;
  notice?: BillingNotice;
}

/** The same Space-owned balance funds writes and provider calls. The financial
 * receipt is permanent; a replay never grants permission to call upstream again.
 */
export class PostgresPaidCallRepository {
  private readonly spaces: WritableSpacePlacements;
  constructor(database: AuthorityDatabase, private readonly billing: SpaceBillingPolicy = spaceBilling) {
    if (database.cacheMode !== "disabled") throw new BillingControlError("cached_authority_forbidden", 500,
      "Paid calls require uncached PostgreSQL");
    this.spaces = new WritableSpacePlacements(database, () => new BillingControlError(
      "space_placement_unavailable", 503, "Space placement is unavailable", true));
  }

  async authorize(input: { spaceId: string; actorUserId: string; creditsWaived: boolean }): Promise<void> {
    if (!this.billing.paidCalls) return;
    return this.spaces.transaction(crypto.randomUUID(), "billing.paid-call.authorize", text(input.spaceId, "spaceId"), async tx => {
      await this.member(tx, input.spaceId, input.actorUserId);
      const admitted = await this.billing.paidCalls!.reserve(tx, { ...input, credits: 0, now: new Date().toISOString() });
      if ("code" in admitted) throw new BillingControlError(admitted.code, admitted.status, admitted.message);
      const required = this.billing.paidCalls!.quote("x_profile_read", 1);
      if (!input.creditsWaived && required !== null && admitted.remaining < required) throw new BillingControlError(
        "credits_exhausted", 402, `Connecting X needs at least ${required} credits for its account check; ` +
        `${admitted.remaining} remain. The owner can buy a pack in Settings → Billing`);
    });
  }

  private async member(tx: Parameters<SpaceBillingPolicy["agentWrite"]>[0], spaceId: string, userId: string) {
    const row = await tx.query({ name: "paid_call_member_v1", text: `SELECT user_id FROM data.space_members
      WHERE space_id=$1 AND user_id=$2 LIMIT 1`, values: [spaceId, text(userId, "actorUserId")], maxRows: 1 });
    if (!row[0]) throw new BillingControlError("forbidden", 403, "Space membership is required");
  }

  async reserve(input: { spaceId: string; callId: string; actorUserId: string; kind: PaidCallKind;
    units: number; creditsWaived: boolean }): Promise<PaidCallReceipt> {
    const spaceId = text(input.spaceId, "spaceId"), callId = text(input.callId, "callId", 200);
    const policy = this.billing.paidCalls;
    if (!policy) return { callId, reservedCredits: 0, chargedCredits: 0, remainingCredits: 0, replayed: false };
    const quoted = policy.quote(input.kind, input.units);
    if (quoted === null || !Number.isSafeInteger(input.units) || input.units < 1) throw new BillingControlError(
      "paid_call_tariff_unavailable", 503, "This X API operation has no configured credit price; no request was sent");
    const digest = await commandDigest({ spaceId, callId, actor: input.actorUserId, kind: input.kind, units: input.units });
    const attemptToken = crypto.randomUUID();
    try { return await this.spaces.transaction(crypto.randomUUID(), "billing.paid-call.reserve", spaceId, async tx => {
      await this.member(tx, spaceId, input.actorUserId);
      // One attempt id is claimed before touching the balance. This serializes
      // duplicate requests even when no receipt or credit-state row exists yet.
      await tx.query({ name: "paid_call_attempt_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        values: [`paid-call:${spaceId}:${callId}`], maxRows: 1 });
      const prior = (await tx.query({ name: "paid_call_receipt_read_v1", text: `SELECT * FROM data.paid_call_receipts
        WHERE space_id=$1 AND call_id=$2`, values: [spaceId, callId], maxRows: 1 }))[0];
      if (prior) {
        if (prior.request_digest !== digest) throw new BillingControlError("idempotency_conflict", 409, "Paid call identity was reused");
        return { callId, reservedCredits: Number(prior.reserved_credits),
          chargedCredits: Number(prior.actual_credits ?? prior.reserved_credits),
          remainingCredits: Number((prior.allocation_json as CreditAllocation).remaining), replayed: true,
          ...(prior.notice_json ? { notice: prior.notice_json as BillingNotice } : {}) };
      }
      const now = new Date().toISOString();
      const allocation = await policy.reserve(tx, { spaceId, now, credits: quoted, creditsWaived: input.creditsWaived });
      if ("code" in allocation) throw new BillingControlError(allocation.code, allocation.status, allocation.message);
      const reservedCredits = allocation.included + allocation.pack + allocation.grace;
      await tx.query({ name: "paid_call_receipt_create_v1", text: `INSERT INTO data.paid_call_receipts
        (space_id,call_id,actor_user_id,request_digest,kind,reserved_units,reserved_credits,allocation_json,
         status,created_at,updated_at,attempt_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'reserved',$9,$9,$10)`,
      values: [spaceId, callId, input.actorUserId, digest, input.kind, input.units, reservedCredits,
        JSON.stringify(allocation), now, attemptToken], maxRows: 0 });
      const result = { callId, reservedCredits, chargedCredits: reservedCredits, remainingCredits: allocation.remaining, replayed: false };
      await commitBillingMutation(tx, { spaceId, commandId: `paid-call-reserve:${callId}`, kind: "paid-call-reserve",
        requestDigest: digest, result, aggregateId: callId, now });
      return result;
    }); } catch (error) {
      if (!(error instanceof DatabaseCommitUnknownError)) throw error;
      // The caller has not received admission, so this invocation cannot have
      // sent X. A fresh attempt token prevents an uncertain COMMIT on a replay
      // from refunding the original invocation that may already be calling X.
      let refunded = false;
      try {
        await this.settle({ spaceId, callId, actualUnits: 0, outcome: "rejected", announce: false, attemptToken });
        refunded = true;
      } catch { /* Missing receipt, another invocation, or unconfirmed refund: never call X. */ }
      throw new BillingControlError("paid_call_admission_unconfirmed", 503, refunded
        ? "Credit admission confirmation was lost; its reservation was refunded. No X request was sent"
        : "Credit admission could not be confirmed. No X request was sent by this attempt; any reservation needs reconciliation");
    }
  }

  async settle(input: { spaceId: string; callId: string; actualUnits: number;
    outcome: "ok" | "rejected" | "uncertain"; announce: boolean; attemptToken?: string }): Promise<PaidCallReceipt> {
    const spaceId = text(input.spaceId, "spaceId"), callId = text(input.callId, "callId", 200);
    const policy = this.billing.paidCalls;
    if (!policy) return { callId, reservedCredits: 0, chargedCredits: 0, remainingCredits: 0, replayed: false };
    return this.spaces.transaction(crypto.randomUUID(), "billing.paid-call.settle", spaceId, async tx => {
      const row = (await tx.query({ name: "paid_call_settlement_lock_v1", text: `SELECT * FROM data.paid_call_receipts
        WHERE space_id=$1 AND call_id=$2 FOR UPDATE`, values: [spaceId, callId], maxRows: 1 }))[0];
      if (!row) throw new BillingControlError("paid_call_not_found", 404, "Paid call receipt is unavailable");
      if (input.attemptToken !== undefined && row.attempt_token !== input.attemptToken) throw new BillingControlError(
        "paid_call_attempt_conflict", 409, "This invocation does not own the paid call reservation");
      if (!Number.isSafeInteger(input.actualUnits) || input.actualUnits < 0 || input.actualUnits > Number(row.reserved_units)) {
        throw new BillingControlError("invalid_paid_call_settlement", 400, "Paid call settlement exceeds its reservation");
      }
      const allocation = row.allocation_json as CreditAllocation;
      if (row.status === "settled") {
        if (Number(row.actual_units) !== input.actualUnits || row.outcome !== input.outcome) throw new BillingControlError(
          "paid_call_settlement_conflict", 409, "Paid call settlement disagrees with its permanent receipt");
        return { callId, reservedCredits: Number(row.reserved_credits),
          chargedCredits: Number(row.actual_credits), remainingCredits: allocation.remaining, replayed: true,
          ...(row.notice_json ? { notice: row.notice_json as BillingNotice } : {}) };
      }
      const chargedCredits = Number(row.reserved_credits) * input.actualUnits / Number(row.reserved_units);
      const refund = Number(row.reserved_credits) - chargedCredits;
      const now = new Date().toISOString();
      const remaining = await policy.refund(tx, { spaceId, now, allocation, credits: refund });
      const notice = input.announce ? await policy.notice?.(tx, { spaceId, now }) : null;
      const finalAllocation = { ...allocation, remaining };
      await tx.query({ name: "paid_call_settled_v1", text: `UPDATE data.paid_call_receipts SET status='settled',
        actual_units=$3,actual_credits=$4,outcome=$5,notice_json=$6::jsonb,allocation_json=$7::jsonb,updated_at=$8
        WHERE space_id=$1 AND call_id=$2`, values: [spaceId, callId, input.actualUnits, chargedCredits,
        input.outcome, JSON.stringify(notice ?? null), JSON.stringify(finalAllocation), now], maxRows: 0 });
      const result = { callId, reservedCredits: Number(row.reserved_credits), chargedCredits,
        remainingCredits: finalAllocation.remaining, replayed: false, ...(notice ? { notice } : {}) };
      await commitBillingMutation(tx, { spaceId, commandId: `paid-call-settle:${callId}`, kind: "paid-call-settle",
        requestDigest: await commandDigest(input), result, aggregateId: callId, now });
      return result;
    });
  }
}

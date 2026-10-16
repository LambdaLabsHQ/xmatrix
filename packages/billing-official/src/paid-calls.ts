import type { BillingTransaction, PaidCallPolicy } from "@xmatrix/billing";
import { CREDITS_PER_SEAT, GRACE_CREDITS_PER_SEAT } from "./credit-allowances.js";

/** X public list prices, verified 2026-10-16:
 * https://docs.x.com/x-api/getting-started/pricing
 * One credit covers at most $0.0005 of provider list cost, before payment/Hub costs.
 * Media's 30 credits/request is a provisional retail price and planning
 * assumption, NOT a verified X upload tariff. Preserve the bounded feature
 * while the operator reconciles the Developer Console's actual charge.
 */
export const X_CALL_CREDITS = Object.freeze({
  x_post: 30, x_post_url: 400, x_post_read: 10, x_profile_read: 20, x_media: 30,
});

const period = (now: string) => `${new Date(now).toISOString().slice(0, 7)}-01`;
const number = (value: unknown) => Number(value ?? 0);

async function lockedState(tx: BillingTransaction, spaceId: string, now: string) {
  await tx.query({ name: "paid_call_credit_state_initialize_v1", text: `INSERT INTO data.space_credit_state
    (space_id,period_start,created_at,updated_at) VALUES ($1,$2::date,$3,$3) ON CONFLICT (space_id) DO NOTHING`,
  values: [spaceId, period(now), now], maxRows: 0 });
  return (await tx.query({ name: "paid_call_credit_state_lock_v1", text: `SELECT period_start::text AS period_start,
    included_used,pack_used,grace_used,pack_balance,notice_level FROM data.space_credit_state
    WHERE space_id=$1 FOR UPDATE`, values: [spaceId], maxRows: 1 }))[0]!;
}

async function balance(tx: BillingTransaction, spaceId: string, now: string): Promise<number> {
  const row = (await tx.query({ name: "paid_call_current_balance_v1", text: `SELECT s.seat_quantity,
    c.period_start::text AS period_start,c.included_used,c.grace_used,c.pack_balance
    FROM data.space_billing_subscriptions s LEFT JOIN data.space_credit_state c USING (space_id)
    WHERE s.space_id=$1 AND s.status IN ('active','trialing')
      AND (s.billing_provider<>'apple' OR s.current_period_end>$2::timestamptz) LIMIT 1`,
  values: [spaceId, now], maxRows: 1 }))[0];
  if (!row) return 0;
  const rolled = !row.period_start || String(row.period_start) < period(now);
  return Math.max(0, number(row.seat_quantity) * CREDITS_PER_SEAT - (rolled ? 0 : number(row.included_used))) +
    number(row.pack_balance) + Math.max(0, number(row.seat_quantity) * GRACE_CREDITS_PER_SEAT - (rolled ? 0 : number(row.grace_used)));
}

export const paidCalls: PaidCallPolicy = {
  quote(kind, units) {
    if (!Number.isSafeInteger(units) || units < 0 || units > 10_000) return null;
    const price = X_CALL_CREDITS[kind];
    return price == null ? null : Math.ceil(price * units);
  },
  async reserve(tx, { spaceId, now, credits, creditsWaived }) {
    if (!Number.isSafeInteger(credits) || credits < 0 || credits > 100_000) throw new Error("Invalid paid call price");
    if (creditsWaived) return { periodStart: period(now), included: 0, pack: 0, grace: 0, remaining: 0 };
    const subscription = (await tx.query({ name: "paid_call_subscription_v1", text: `SELECT seat_quantity,
      (SELECT count(*) FROM data.space_members WHERE space_id=$1 AND role IN ('owner','admin','member')) AS members
      FROM data.space_billing_subscriptions WHERE space_id=$1 AND status IN ('active','trialing')
        AND (billing_provider<>'apple' OR current_period_end>$2::timestamptz) LIMIT 1`,
    values: [spaceId, now], maxRows: 1 }))[0];
    if (!subscription) return { code: "paid_x_pro_required", status: 402,
      message: "X API actions require an active Pro plan. The Space owner can upgrade in Settings → Billing" };
    if (number(subscription.members) > number(subscription.seat_quantity)) return { code: "billing_seat_limit", status: 402,
      message: "This Space has more billable members than its purchased seats" };
    if (credits === 0) return { periodStart: period(now), included: 0, pack: 0, grace: 0,
      remaining: await balance(tx, spaceId, now) };
    const row = await lockedState(tx, spaceId, now);
    const start = period(now);
    const rolled = String(row.period_start) < start;
    const includedUsed = rolled ? 0 : number(row.included_used);
    const graceUsed = rolled ? 0 : number(row.grace_used);
    const includedLeft = Math.max(0, number(subscription.seat_quantity) * CREDITS_PER_SEAT - includedUsed);
    const graceLeft = Math.max(0, number(subscription.seat_quantity) * GRACE_CREDITS_PER_SEAT - graceUsed);
    const available = includedLeft + number(row.pack_balance) + graceLeft;
    if (credits > available) return { code: "credits_exhausted", status: 402,
      message: `This X API call needs ${credits} credits; ${available} remain. No request was sent. ` +
        "The owner can buy a credit pack in Settings → Billing",
      details: { requiredCredits: credits, remainingCredits: available } };
    const included = Math.min(credits, includedLeft);
    const pack = Math.min(credits - included, number(row.pack_balance));
    const grace = credits - included - pack;
    await tx.query({ name: "paid_call_credit_reserve_v1", text: `UPDATE data.space_credit_state SET
      period_start=GREATEST(period_start,$2::date),included_used=$3,pack_used=$4,grace_used=$5,
      pack_balance=pack_balance-$6,notice_level=CASE WHEN period_start<$2::date THEN 0 ELSE notice_level END,
      version=version+1,updated_at=GREATEST(updated_at,$7::timestamptz) WHERE space_id=$1`,
    values: [spaceId, start, includedUsed + included, (rolled ? 0 : number(row.pack_used)) + pack,
      graceUsed + grace, pack, now], maxRows: 0 });
    return { periodStart: String(row.period_start) > start ? String(row.period_start) : start,
      included, pack, grace, remaining: available - credits };
  },
  async refund(tx, { spaceId, now, allocation, credits }) {
    if (!Number.isSafeInteger(credits) || credits < 0 || credits > allocation.included + allocation.pack + allocation.grace) {
      throw new Error("Invalid paid call refund");
    }
    if (!credits) return balance(tx, spaceId, now);
    // Reverse the allocation order. An expired monthly allowance never becomes
    // a new month's free credits; purchased balance is always restored.
    const grace = Math.min(credits, allocation.grace);
    const pack = Math.min(credits - grace, allocation.pack);
    const included = credits - grace - pack;
    await tx.query({ name: "paid_call_credit_refund_v1", text: `UPDATE data.space_credit_state SET
      included_used=included_used-CASE WHEN period_start=$2::date THEN $3 ELSE 0 END,
      pack_used=pack_used-CASE WHEN period_start=$2::date THEN $4 ELSE 0 END,
      grace_used=grace_used-CASE WHEN period_start=$2::date THEN $5 ELSE 0 END,
      pack_balance=pack_balance+$4,version=version+1,updated_at=GREATEST(updated_at,$6::timestamptz)
      WHERE space_id=$1`, values: [spaceId, allocation.periodStart, included, pack, grace, now], maxRows: 0 });
    return balance(tx, spaceId, now);
  },
  async notice(tx, { spaceId, now }) {
    const row = (await tx.query({ name: "paid_call_notice_v1", text: `SELECT c.period_start::text AS period_start,
      c.included_used,c.grace_used,c.pack_balance,c.notice_level,s.seat_quantity FROM data.space_credit_state c
      JOIN data.space_billing_subscriptions s USING (space_id) WHERE c.space_id=$1 FOR UPDATE OF c`,
    values: [spaceId], maxRows: 1 }))[0];
    if (!row || String(row.period_start) !== period(now)) return null;
    const included = number(row.seat_quantity) * CREDITS_PER_SEAT;
    const level = number(row.grace_used) >= number(row.seat_quantity) * GRACE_CREDITS_PER_SEAT && number(row.pack_balance) === 0
      ? 3 : number(row.included_used) >= included ? 2 : number(row.included_used) * 5 >= included * 4 ? 1 : 0;
    if (level <= number(row.notice_level)) return null;
    await tx.query({ name: "paid_call_notice_mark_v1", text: `UPDATE data.space_credit_state SET notice_level=$2,
      version=version+1,updated_at=GREATEST(updated_at,$3::timestamptz) WHERE space_id=$1`,
    values: [spaceId, level, now], maxRows: 0 });
    return { key: `credits:${period(now)}:${level}`, body: level === 3
      ? "This Space has used its Agent credits and grace. Agent and paid X actions are paused; buy a pack in Settings → Billing. People can still write."
      : level === 2 ? "This Space has used its included Agent credits. Packs and grace are now in use; see Settings → Billing."
      : "This Space has used 80% of its included Agent credits. See Settings → Billing." };
  },
};

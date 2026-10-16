/**
 * The official xMatrix deployment's Space plans: a Free Space has three human
 * seats and 500 messages; a paid Space has the seats its Stripe subscription
 * bought, each with a monthly allowance of Agent credits (docs/design/agent-credits.md),
 * and is read-only while a past-due payment is in its grace period.
 * The official build supplies this policy under the `@xmatrix/billing` name.
 */
import type {
  BillingNotice, BillingRejection, BillingTransaction, SpaceBillingPolicy,
} from "@xmatrix/billing";

export const FREE_SPACE_HUMAN_SEAT_LIMIT = 3;
export const FREE_SPACE_MESSAGE_LIMIT = 500;
/** Credits each purchased seat includes per calendar month (UTC). */
export const CREDITS_PER_SEAT = 5_000;
/** Credits each seat may still use once included and pack credits are gone. */
export const GRACE_CREDITS_PER_SEAT = 2_500;
/** Credits one credit pack adds. */
export const CREDIT_PACK_CREDITS = 10_000;

interface SubscriptionRow extends Record<string, unknown> {
  status: string;
  grace_until: Date | string | null;
  seat_quantity: string | number;
}

const PAST_DUE_READ_ONLY: BillingRejection = {
  code: "billing_grace_read_only",
  status: 402,
  message: "This Space is read-only while a past-due payment is being resolved",
};

function graceActive(subscription: Record<string, unknown> | undefined, now: string): boolean {
  return subscription?.status === "past_due" && subscription.grace_until != null &&
    new Date(subscription.grace_until as string | Date).getTime() > Date.parse(now);
}

async function seatAdmission(
  transaction: BillingTransaction,
  { spaceId, now }: { spaceId: string; now: string },
): Promise<BillingRejection | null> {
  await transaction.query({ name: "official_space_billing_mutex_v1",
    text: "SELECT space_id FROM data.spaces WHERE space_id=$1 FOR UPDATE", values: [spaceId], maxRows: 1 });
  const pendingApple = await transaction.query({ name: "official_space_apple_pending_v1",
    text: `SELECT checkout_intent_id FROM data.space_billing_checkout_intents WHERE space_id=$1
      AND billing_provider='apple' AND status IN ('pending','created') AND expires_at>$2 LIMIT 1`,
    values: [spaceId, now], maxRows: 1 });
  if (pendingApple.length) return { code: "billing_checkout_in_progress", status: 409,
    message: "Complete the pending single-seat App Store purchase before adding billable members" };
  const subscription = (await transaction.query<SubscriptionRow>({
    name: "official_space_seat_subscription_v1",
    text: `SELECT CASE WHEN billing_provider='apple' AND
        (current_period_end IS NULL OR current_period_end <= $2::timestamptz)
        THEN 'canceled' ELSE status END AS status,grace_until,seat_quantity
      FROM data.space_billing_subscriptions
      WHERE space_id = $1 FOR UPDATE`,
    values: [spaceId, now], maxRows: 1,
  }))[0];
  if (graceActive(subscription, now)) return PAST_DUE_READ_ONLY;
  const paid = subscription?.status === "active" || subscription?.status === "trialing";
  const counts = await transaction.query<{ count: string | number }>({
    name: "official_space_seat_count_v1",
    text: `SELECT COUNT(*) AS count FROM data.space_members
      WHERE space_id = $1 AND role IN ('owner','admin','member')`,
    values: [spaceId], maxRows: 1,
  });
  const used = Number(counts[0]?.count ?? 0);
  const limit = paid ? Number(subscription!.seat_quantity) : FREE_SPACE_HUMAN_SEAT_LIMIT;
  if (used < limit) return null;
  return {
    code: "billing_seat_limit", status: 409, message: "This Space has reached its human seat limit",
    details: { spaceId, usedSeats: used, seatLimit: limit, paid },
  };
}

/** The Space's subscription as entitlement reads it: an Apple period that has
 * ended is over even before the provider says so. */
function subscriptionCte(space: string, now: string): string {
  return `subscription AS MATERIALIZED (
        SELECT CASE WHEN billing_provider='apple' AND
          (current_period_end IS NULL OR current_period_end <= ${now})
          THEN 'canceled' ELSE status END AS status,grace_until,seat_quantity
        FROM data.space_billing_subscriptions
        WHERE space_id=${space} LIMIT 1
      )`;
}

/** A paid Space's purchased seats and billable members. */
function paidSeatsCte(space: string): string {
  return `paid_seats AS MATERIALIZED (
        SELECT seat_quantity::bigint AS seat_quantity,
          (SELECT COUNT(*) FROM data.space_members
            WHERE space_id=${space} AND role IN ('owner','admin','member')) AS seat_count
        FROM subscription WHERE status IN ('active','trialing')
      )`;
}

/** The month's allowance when this write is charged a credit: a paid Space
 * within its seats, and `charged` true. No row means no credit is charged. */
function creditMeterCte(now: string, charged: string): string {
  return `credit_meter AS MATERIALIZED (
        SELECT seat_quantity*${CREDITS_PER_SEAT} AS included,
          seat_quantity*${GRACE_CREDITS_PER_SEAT} AS grace,
          date_trunc('month',${now} AT TIME ZONE 'UTC')::date AS period_start
        FROM paid_seats WHERE ${charged} AND seat_count<=seat_quantity
      )`;
}

/**
 * Charge one credit: included first, then the pack balance, then the grace.
 * One upsert on the Space's row decides and records it, so concurrent writes
 * serialize on that row and never overspend. A write in a later month starts
 * the counters again. Returns no row when nothing is left to charge.
 */
function creditChargeCte(space: string, now: string): string {
  const rolled = "s.period_start<EXCLUDED.period_start";
  const current = (column: string) => `(CASE WHEN ${rolled} THEN 0 ELSE s.${column} END)`;
  const included = "(SELECT included FROM credit_meter)";
  const grace = "(SELECT grace FROM credit_meter)";
  const toIncluded = `(${current("included_used")}<${included})`;
  const toPack = `(NOT ${toIncluded} AND s.pack_balance>0)`;
  const toGrace = `(NOT ${toIncluded} AND s.pack_balance=0 AND ${current("grace_used")}<${grace})`;
  const includedAfter = `(${current("included_used")}+CASE WHEN ${toIncluded} THEN 1 ELSE 0 END)`;
  const level = `(CASE WHEN ${toGrace} AND ${current("grace_used")}+1>=${grace} THEN 3
          WHEN ${includedAfter}>=${included} THEN 2
          WHEN ${includedAfter}*5>=${included}*4 THEN 1 ELSE 0 END)`;
  return `credit AS (
        INSERT INTO data.space_credit_state AS s
          (space_id,period_start,included_used,pack_used,grace_used,pack_balance,
           notice_level,notice_version,version,created_at,updated_at)
        SELECT ${space},period_start,1,0,0,0,0,0,1,${now},${now} FROM credit_meter
        ON CONFLICT (space_id) DO UPDATE SET
          period_start=GREATEST(s.period_start,EXCLUDED.period_start),
          included_used=${includedAfter},
          pack_used=${current("pack_used")}+CASE WHEN ${toPack} THEN 1 ELSE 0 END,
          pack_balance=s.pack_balance-CASE WHEN ${toPack} THEN 1 ELSE 0 END,
          grace_used=${current("grace_used")}+CASE WHEN ${toGrace} THEN 1 ELSE 0 END,
          notice_level=GREATEST(${current("notice_level")},${level}),
          notice_version=CASE WHEN ${level}>${current("notice_level")} THEN s.version+1
            ELSE s.notice_version END,
          version=s.version+1,updated_at=GREATEST(${now},s.created_at)
        WHERE ${toIncluded} OR ${toPack} OR ${toGrace}
        RETURNING included_used,pack_used,grace_used,pack_balance,notice_level,
          notice_version=version AS notice_raised,period_start
      )`;
}

/** The credit columns an admission row carries. */
const CREDIT_COLUMNS = `EXISTS (SELECT 1 FROM credit_meter) AS credit_metered,
          (SELECT included FROM credit_meter) AS credit_included,
          (SELECT grace FROM credit_meter) AS credit_grace,
          (SELECT included_used FROM credit) AS credit_included_used,
          (SELECT pack_balance FROM credit) AS credit_pack_balance,
          (SELECT grace_used FROM credit) AS credit_grace_used,
          (SELECT notice_level FROM credit) AS credit_notice_level,
          (SELECT notice_raised FROM credit) AS credit_notice_raised,
          (SELECT period_start::text FROM credit) AS credit_period_start`;

/** The first day of the month after `now`, as the day credits come back. */
function nextPeriod(now: string): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function creditsExhausted(now: string): BillingRejection {
  return {
    code: "credits_exhausted", status: 402,
    message: `This Space has used this month's Agent credits; Agents and apps can write again on ${nextPeriod(now)}, ` +
      "or sooner once the owner adds seats. People can still write",
    details: { resumesOn: nextPeriod(now) },
  };
}

/** A charged write was refused: the Space is paid and nothing was left to charge. */
function creditRefused(row: Record<string, unknown>): boolean {
  return row.credit_metered === true && row.credit_included_used == null;
}

function creditNotice(row: Record<string, unknown>): BillingNotice | null {
  if (row.credit_notice_raised !== true) return null;
  const level = Number(row.credit_notice_level);
  const period = String(row.credit_period_start ?? "");
  const included = Number(row.credit_included).toLocaleString("en-US");
  const used = Number(row.credit_included_used).toLocaleString("en-US");
  const packs = Number(row.credit_pack_balance ?? 0);
  const grace = Number(row.credit_grace).toLocaleString("en-US");
  const where = "Settings → Billing";
  const body = level >= 3
    ? `This Space has used this month's Agent credits and their grace. Agent and app ` +
      `messages and page edits are paused until ${nextPeriod(`${period}T00:00:00Z`)} unless the owner adds seats ` +
      `in ${where}. People can still write.`
    : level === 2
      ? `This Space has used all ${included} Agent credits included this month. Agents keep working on ` +
        `${packs > 0 ? `${packs.toLocaleString("en-US")} credit pack credits, then ` : ""}a grace of ${grace} ` +
        `credits; add seats in ${where} to keep them running after that.`
      : `This Space has used ${used} of the ${included} Agent credits included this month. Each message or ` +
        `page revision by an Agent or app uses one credit; people write for free. See ${where}.`;
  return { key: `credits:${period}:${level}`, body };
}

export const spaceBilling: SpaceBillingPolicy = {
  id: "official",
  metered: true,
  credits: { perSeat: CREDITS_PER_SEAT, gracePerSeat: GRACE_CREDITS_PER_SEAT, packCredits: CREDIT_PACK_CREDITS },

  async spaceCreated(transaction, { spaceId, now }) {
    await transaction.query({
      name: "official_space_billing_usage_create_v1",
      text: `INSERT INTO data.space_billing_usage
        (space_id, free_message_count, version, created_at, updated_at)
        VALUES ($1, 0, 1, $2, $2)`,
      values: [spaceId, now], maxRows: 0,
    });
  },

  async spaceDeletion(transaction, { spaceId, now, intent }) {
    const subscriptions = await transaction.query<{ status: string }>({
      name: "official_space_delete_subscription_v1",
      text: "SELECT status FROM data.space_billing_subscriptions WHERE space_id=$1 FOR UPDATE",
      values: [spaceId], maxRows: 1,
    });
    if (intent !== "account-deletion" && subscriptions[0] && !["canceled", "incomplete_expired"].includes(subscriptions[0].status)) {
      return {
        code: "conflict", status: 409,
        message: "Cancel the Space subscription and wait for provider confirmation before deletion",
      };
    }
    const checkouts = await transaction.query({
      name: "official_space_delete_checkout_v1",
      text: `SELECT checkout_intent_id FROM data.space_billing_checkout_intents
        WHERE space_id=$1 AND status IN ('pending','created') AND expires_at > $2 LIMIT 1`,
      values: [spaceId, now], maxRows: 1,
    });
    if (checkouts[0]) {
      return {
        code: "conflict", status: 409,
        message: "Complete or let the active billing checkout expire before deletion",
      };
    }
    return null;
  },

  seatAdmission,

  message: {
    // The exact Free counter and a paid Space's credit advance in the
    // publishing statement itself, so their row locks are not held across
    // another round trip.
    ctes: `${subscriptionCte("$2", "$6::timestamptz")}, ${paidSeatsCte("$2")},
      ${creditMeterCte("$6::timestamptz", "$10 AND $13 IN ('agent','app') AND NOT $14")},
      ${creditChargeCte("$2", "$6::timestamptz")}, prior_usage AS MATERIALIZED (
        SELECT free_message_count FROM data.space_billing_usage WHERE space_id=$2 LIMIT 1
      ), usage AS (
        UPDATE data.space_billing_usage SET
          free_message_count=free_message_count+1,
          version=version+1,updated_at=GREATEST($6::timestamptz,created_at)
        WHERE $10 AND space_id=$2 AND free_message_count<${FREE_SPACE_MESSAGE_LIMIT}
          AND NOT EXISTS (SELECT 1 FROM subscription WHERE status IN ('active','trialing'))
          AND NOT EXISTS (SELECT 1 FROM subscription WHERE status='past_due'
            AND grace_until IS NOT NULL AND grace_until>$6::timestamptz)
        RETURNING free_message_count
      ), admission AS MATERIALIZED (
        SELECT
          (SELECT status FROM subscription) AS status,
          (SELECT grace_until FROM subscription) AS grace_until,
          (SELECT seat_quantity FROM subscription) AS seat_quantity,
          (SELECT seat_count FROM paid_seats) AS seat_count,
          (SELECT free_message_count FROM prior_usage) AS prior_free_message_count,
          (SELECT free_message_count FROM usage) AS free_message_count,
          ${CREDIT_COLUMNS}
      )`,
    accepts: `(status IN ('active','trialing') AND seat_count<=seat_quantity
        AND (NOT credit_metered OR credit_included_used IS NOT NULL))
      OR (status IS DISTINCT FROM 'active' AND status IS DISTINCT FROM 'trialing'
        AND NOT (status='past_due' AND grace_until IS NOT NULL
          AND grace_until>$6::timestamptz) AND free_message_count IS NOT NULL)`,
    rejection(row, { now }) {
      if (graceActive(row, now)) return PAST_DUE_READ_ONLY;
      if (row.status === "active" || row.status === "trialing") {
        if (Number(row.seat_count ?? 0) > Number(row.seat_quantity)) {
          return {
            code: "billing_seat_limit", status: 409,
            message: "This Space has more billable members than its purchased seat limit",
          };
        }
        return creditRefused(row) ? creditsExhausted(now) : null;
      }
      if (row.free_message_count != null) return null;
      if (row.prior_free_message_count == null) {
        return {
          code: "billing_usage_unavailable", status: 503,
          message: "Space billing usage is unavailable", retryable: true,
        };
      }
      return {
        code: "payment_required", status: 402,
        message: `This Free Space has reached its ${FREE_SPACE_MESSAGE_LIMIT}-message allowance; upgrade to continue`,
      };
    },
    notice: creditNotice,
  },

  async agentWrite(transaction, { spaceId, now }) {
    const row = (await transaction.query({
      name: "official_space_agent_write_credit_v1",
      text: `WITH ${subscriptionCte("$1", "$2::timestamptz")}, ${paidSeatsCte("$1")},
        ${creditMeterCte("$2::timestamptz", "TRUE")}, ${creditChargeCte("$1", "$2::timestamptz")}
        SELECT ${CREDIT_COLUMNS}`,
      values: [spaceId, now], maxRows: 1,
    }))[0];
    return row && creditRefused(row) ? creditsExhausted(now) : null;
  },
};

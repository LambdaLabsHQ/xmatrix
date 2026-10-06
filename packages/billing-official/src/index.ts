/**
 * The official xMatrix deployment's Space plans: a Free Space has three human
 * seats and 500 messages; a paid Space has the seats its Stripe subscription
 * bought, and is read-only while a past-due payment is in its grace period.
 * The official build supplies this policy under the `@xmatrix/billing` name.
 */
import type { BillingRejection, BillingTransaction, SpaceBillingPolicy } from "@xmatrix/billing";

export const FREE_SPACE_HUMAN_SEAT_LIMIT = 3;
export const FREE_SPACE_MESSAGE_LIMIT = 500;

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
  const subscription = (await transaction.query<SubscriptionRow>({
    name: "official_space_seat_subscription_v1",
    text: `SELECT status,grace_until,seat_quantity FROM data.space_billing_subscriptions
      WHERE space_id = $1 FOR UPDATE`,
    values: [spaceId], maxRows: 1,
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

export const spaceBilling: SpaceBillingPolicy = {
  id: "official",
  metered: true,

  async spaceCreated(transaction, { spaceId, now }) {
    await transaction.query({
      name: "official_space_billing_usage_create_v1",
      text: `INSERT INTO data.space_billing_usage
        (space_id, free_message_count, version, created_at, updated_at)
        VALUES ($1, 0, 1, $2, $2)`,
      values: [spaceId, now], maxRows: 0,
    });
  },

  async spaceDeletion(transaction, { spaceId, now }) {
    const subscriptions = await transaction.query<{ status: string }>({
      name: "official_space_delete_subscription_v1",
      text: "SELECT status FROM data.space_billing_subscriptions WHERE space_id=$1 FOR UPDATE",
      values: [spaceId], maxRows: 1,
    });
    if (subscriptions[0] && !["canceled", "incomplete_expired"].includes(subscriptions[0].status)) {
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
    // The exact Free counter advances in the publishing statement itself, so
    // its row lock is not held across another round trip.
    ctes: `subscription AS MATERIALIZED (
        SELECT status,grace_until,seat_quantity FROM data.space_billing_subscriptions
        WHERE space_id=$2 LIMIT 1
      ), prior_usage AS MATERIALIZED (
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
          CASE WHEN EXISTS (SELECT 1 FROM subscription WHERE status IN ('active','trialing'))
            THEN (SELECT COUNT(*) FROM data.space_members
              WHERE space_id=$2 AND role IN ('owner','admin','member')) ELSE NULL END AS seat_count,
          (SELECT free_message_count FROM prior_usage) AS prior_free_message_count,
          (SELECT free_message_count FROM usage) AS free_message_count
      )`,
    accepts: `(status IN ('active','trialing') AND seat_count<=seat_quantity)
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
        return null;
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
  },
};

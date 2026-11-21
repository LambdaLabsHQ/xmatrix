import type { QueryResultRow } from "pg";

import type { AuthorityDatabase } from "./contracts.js";
import { BILLING_GRANT_DAYS, BillingControlError, PostgresBillingRepository } from "./billing-control.js";

/** Grants any operator may give in one UTC day, across everyone. */
export const BILLING_GRANT_DAILY_LIMIT = 20;

export interface BillingGrant {
  grantId: string;
  userId: string;
  spaceId: string;
  reference: string;
  reason: string;
  actor: string;
  seatQuantity: number;
  periodEnd: string;
  createdAt: string;
}

interface GrantRow extends QueryResultRow {
  grant_id: string; user_id: string; space_id: string; reference: string; reason: string;
  actor: string; seat_quantity: number | string; period_end: Date | string; created_at: Date | string;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const view = (row: GrantRow): BillingGrant => ({
  grantId: row.grant_id, userId: row.user_id, spaceId: row.space_id, reference: row.reference,
  reason: row.reason, actor: row.actor, seatQuantity: Number(row.seat_quantity),
  periodEnd: iso(row.period_end), createdAt: iso(row.created_at),
});

function field(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new BillingControlError("invalid_billing_grant", 400, `${name} is invalid`);
  }
  return value.trim();
}

/**
 * Complimentary Pro for feedback. The global ledger holds the rules no
 * caller can talk its way around: one grant per person, one per piece of
 * feedback, a daily cap, and a fixed length. The Space's own subscription
 * row is then written on its shard; a refusal there releases the ledger row,
 * so a Space that cannot take the grant does not use up its owner's one.
 */
export class PostgresBillingGrantRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly billing: PostgresBillingRepository) {
    if (database.cacheMode !== "disabled") throw new BillingControlError("cached_authority_forbidden", 500, "Billing grants require uncached authority");
  }

  async read(requestId: string, userId: string): Promise<BillingGrant | null> {
    return this.database.transaction({ requestId, operation: "billing.grant.read" }, async (tx) => {
      const rows = await tx.query<GrantRow>({ name: "billing_grant_by_user_v1",
        text: "SELECT * FROM control.billing_grants WHERE user_id=$1 LIMIT 1", values: [userId], maxRows: 1 });
      return rows[0] ? view(rows[0]) : null;
    });
  }

  async grant(input: {
    requestId: string; userId: unknown; spaceId: unknown; reference: unknown; reason: unknown; actor: string;
    dailyLimit?: number;
  }): Promise<{ grant: BillingGrant; replayed: boolean; billing: Record<string, unknown> }> {
    const userId = field(input.userId, "userId", 300);
    const spaceId = field(input.spaceId, "spaceId", 300);
    const reference = field(input.reference, "reference", 500);
    const reason = field(input.reason, "reason", 1000);
    const actor = field(input.actor, "actor", 300);
    const dailyLimit = input.dailyLimit ?? BILLING_GRANT_DAILY_LIMIT;
    const { grant, replayed } = await this.database.transaction(
      { requestId: input.requestId, operation: "billing.grant.reserve" }, async (tx) => {
        // Grants take turns, so the daily cap and the one-per-person rule hold under concurrency.
        await tx.query({ name: "billing_grant_lock_v1",
          text: "SELECT pg_advisory_xact_lock(hashtextextended('billing-grants',0))", values: [], maxRows: 1 });
        const existing = await tx.query<GrantRow>({ name: "billing_grant_existing_v1",
          text: "SELECT * FROM control.billing_grants WHERE user_id=$1 OR reference=$2 LIMIT 2",
          values: [userId, reference], maxRows: 2 });
        const same = existing.find(row => row.user_id === userId && row.reference === reference && row.space_id === spaceId);
        if (same) return { grant: view(same), replayed: true };
        if (existing.some(row => row.user_id === userId)) throw new BillingControlError(
          "billing_grant_already_used", 409, "This person has already received complimentary Pro");
        if (existing.length) throw new BillingControlError(
          "billing_grant_reference_used", 409, "This feedback has already earned complimentary Pro for someone else");
        const today = await tx.query<{ count: string | number }>({ name: "billing_grant_daily_count_v1",
          text: "SELECT COUNT(*) AS count FROM control.billing_grants WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
          values: [], maxRows: 1 });
        if (Number(today[0]?.count ?? 0) >= dailyLimit) throw new BillingControlError(
          "billing_grant_daily_limit", 429, `At most ${dailyLimit} grants can be given per UTC day`, true);
        const rows = await tx.query<GrantRow>({ name: "billing_grant_insert_v1",
          text: `INSERT INTO control.billing_grants
            (grant_id,user_id,space_id,reference,reason,actor,seat_quantity,period_end)
            VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,1,now() + make_interval(days => $6)) RETURNING *`,
          values: [userId, spaceId, reference, reason, actor, BILLING_GRANT_DAYS], maxRows: 1 });
        return { grant: view(rows[0]!), replayed: false };
      });
    let applied: { seatQuantity: number; billing: Record<string, unknown> };
    try {
      applied = await this.billing.applyGrant({ requestId: input.requestId, grantId: grant.grantId,
        spaceId, userId, periodEnd: grant.periodEnd });
    } catch (error) {
      // A Space that refuses the grant gives the person their one grant back;
      // a failure that may be retried keeps it, and the same call finishes it.
      if (!replayed && error instanceof BillingControlError && !error.retryable) {
        await this.database.transaction({ requestId: input.requestId, operation: "billing.grant.release" }, (tx) =>
          tx.query({ name: "billing_grant_release_v1", text: "DELETE FROM control.billing_grants WHERE grant_id=$1",
            values: [grant.grantId], maxRows: 0 }));
      }
      throw error;
    }
    if (applied.seatQuantity !== grant.seatQuantity) {
      await this.database.transaction({ requestId: input.requestId, operation: "billing.grant.seats" }, (tx) =>
        tx.query({ name: "billing_grant_seats_record_v1", text: "UPDATE control.billing_grants SET seat_quantity=$2 WHERE grant_id=$1",
          values: [grant.grantId, applied.seatQuantity], maxRows: 0 }));
    }
    return { grant: { ...grant, seatQuantity: applied.seatQuantity }, replayed, billing: applied.billing };
  }
}

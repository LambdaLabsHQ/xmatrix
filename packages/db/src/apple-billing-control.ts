import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { BillingControlError, PostgresBillingRepository } from "./billing-control.js";
import { boundedDatabaseIdentifier } from "./identifiers.js";
import { accountRevokedSql } from "./account-deletion.js";

export interface AppleAccountBinding {
  appAccountToken: string;
  spaceId: string;
  ownerUserId: string;
  accountDeleted: boolean;
}

/** One seat an organization assigned through the App Store, as Apple last signed it. */
export interface AppleAssignedSeat {
  environment: "Production" | "Sandbox";
  originalTransactionId: string;
  productId: string;
  expiresAt: string;
  active: boolean;
  signedAt: string;
}

/** Where an organization's seats are counted, and how many are in force. */
export interface AppleSeatGroupState {
  groupKey: string;
  spaceId: string;
  ownerUserId: string;
  /** The seat holder's role in the group's Space, null when they are not in it. */
  holderRole: string | null;
  activeSeats: number;
  productId: string;
  periodEnd: string;
}

/** Immutable global purchase identity; this table does not grant entitlements. */
export class PostgresAppleBillingRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly billing: PostgresBillingRepository) {
    if (database.cacheMode !== "disabled") throw new BillingControlError("cached_authority_forbidden", 500, "Apple billing requires uncached authority");
  }

  async prepare(input: { requestId: string; commandId: string; spaceId: string; actorUserId: string; interval: "month" | "year"; productId: string }) {
    // The Space transaction verifies the owner, one human seat, provider conflict,
    // and reserves a checkout before we return a token to StoreKit.
    await this.billing.createCheckoutIntent({ ...input, priceId: input.productId, seatQuantity: 1, billingProvider: "apple" });
    return this.database.transaction({ requestId: input.requestId, operation: "apple.purchase.prepare" }, async (tx) => {
      const rows = await tx.query<{ app_account_token: string }>({
        name: "apple_account_token_create_v1",
        text: `INSERT INTO control.apple_account_tokens(app_account_token,space_id,owner_user_id)
          VALUES ($1,$2,$3) ON CONFLICT (space_id,owner_user_id)
          DO UPDATE SET space_id=EXCLUDED.space_id RETURNING app_account_token`,
        values: [crypto.randomUUID(), input.spaceId, input.actorUserId], maxRows: 1,
      });
      return { appAccountToken: rows[0].app_account_token, productId: input.productId };
    });
  }

  async resolve(requestId: string, token: string): Promise<AppleAccountBinding | null> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(token)) return null;
    return this.database.transaction({ requestId, operation: "apple.purchase.resolve" }, async (tx) => {
      const rows = await tx.query<{ app_account_token: string; space_id: string; owner_user_id: string; account_deleted: boolean }>({
        name: "apple_account_token_read_v3", text: `SELECT t.app_account_token,t.space_id,t.owner_user_id,
          ${accountRevokedSql("t.owner_user_id")} AS account_deleted
          FROM control.apple_account_tokens t WHERE t.app_account_token=$1 LIMIT 1`, values: [token], maxRows: 1,
      });
      const row = rows[0];
      return row ? { appAccountToken: row.app_account_token, spaceId: row.space_id, ownerUserId: row.owner_user_id, accountDeleted: row.account_deleted } : null;
    });
  }

  async claim(requestId: string, environment: "Production" | "Sandbox", originalTransactionId: string, token: string): Promise<void> {
    boundedDatabaseIdentifier(originalTransactionId, "originalTransactionId");
    if (!/^[0-9]{1,100}$/.test(originalTransactionId)) throw new BillingControlError("invalid_apple_transaction", 400, "Invalid Apple transaction identifier");
    await this.database.transaction({ requestId, operation: "apple.subscription.claim" }, async (tx) => {
      await tx.query({ name: "apple_subscription_claim_v1", text: `INSERT INTO control.apple_subscription_bindings
        (environment,original_transaction_id,app_account_token) VALUES ($1,$2,$3)
        ON CONFLICT (environment,original_transaction_id) DO NOTHING`, values: [environment, originalTransactionId, token], maxRows: 0 });
      const rows = await tx.query<{ app_account_token: string }>({ name: "apple_subscription_binding_v1",
        text: `SELECT app_account_token FROM control.apple_subscription_bindings
          WHERE environment=$1 AND original_transaction_id=$2 FOR UPDATE`, values: [environment, originalTransactionId], maxRows: 1 });
      if (rows[0]?.app_account_token.toLowerCase() !== token.toLowerCase()) throw new BillingControlError(
        "apple_subscription_bound_elsewhere", 409, "This Apple subscription is already bound to another Space; rebinding is not supported");
    });
  }

  /**
   * Record an assigned seat. The transaction belongs for good to the first user
   * who restores it, and a group to the Space it was first restored from, which
   * that user must own. A later restore or notification only refreshes Apple's
   * facts, and an older signature never replaces a newer one.
   */
  async claimAssignedSeat(requestId: string, input: AppleAssignedSeat & { userId: string; groupKey: string; spaceId: string }): Promise<AppleSeatGroupState> {
    const seat = this.seat(input);
    const userId = boundedDatabaseIdentifier(input.userId, "userId");
    const groupKey = boundedDatabaseIdentifier(input.groupKey, "groupKey");
    const spaceId = boundedDatabaseIdentifier(input.spaceId, "spaceId");
    return this.database.transaction({ requestId, operation: "apple.assigned-seat.claim" }, async (tx) => {
      const existing = await tx.query<{ user_id: string; group_key: string }>({ name: "apple_assigned_seat_lock_v1",
        text: `SELECT user_id,group_key FROM control.apple_assigned_seats
          WHERE environment=$1 AND original_transaction_id=$2 FOR UPDATE`, values: [seat.environment, seat.originalTransactionId], maxRows: 1 });
      if (existing[0] && existing[0].user_id !== userId) throw new BillingControlError(
        "apple_subscription_bound_elsewhere", 409, "This App Store seat already belongs to another xMatrix account; rebinding is not supported");
      const key = existing[0]?.group_key ?? groupKey;
      const bound = await tx.query<{ space_id: string }>({ name: "apple_seat_group_read_v1",
        text: "SELECT space_id FROM control.apple_seat_groups WHERE environment=$1 AND group_key=$2 FOR UPDATE",
        values: [seat.environment, key], maxRows: 1 });
      if (!bound[0]) {
        const roles = await tx.query<{ role: string }>({ name: "apple_seat_group_owner_v1",
          text: "SELECT role FROM control.user_space_memberships WHERE user_id=$1 AND space_id=$2 LIMIT 1",
          values: [userId, spaceId], maxRows: 1 });
        if (roles[0]?.role !== "owner") throw new BillingControlError("apple_seat_space_owner_required", 409,
          "Open a Space you own to start your organization's App Store seats there");
        await tx.query({ name: "apple_seat_group_insert_v1", text: `INSERT INTO control.apple_seat_groups(environment,group_key,space_id)
          VALUES ($1,$2,$3)`, values: [seat.environment, key, spaceId], maxRows: 0 });
      }
      await tx.query({ name: "apple_assigned_seat_upsert_v1", text: `INSERT INTO control.apple_assigned_seats
          (environment,original_transaction_id,user_id,group_key,product_id,expires_at,active,signed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (environment,original_transaction_id) DO UPDATE SET product_id=EXCLUDED.product_id,
          expires_at=EXCLUDED.expires_at, active=EXCLUDED.active, signed_at=EXCLUDED.signed_at, updated_at=clock_timestamp()
        WHERE control.apple_assigned_seats.signed_at <= EXCLUDED.signed_at`,
        values: [seat.environment, seat.originalTransactionId, userId, key, seat.productId, seat.expiresAt, seat.active, seat.signedAt], maxRows: 0 });
      return this.groupState(tx, seat.environment, key, userId);
    });
  }

  /** The Space a group's seats are counted in, or null before its first seat is restored. */
  async seatGroupSpace(requestId: string, environment: "Production" | "Sandbox", groupKey: string): Promise<string | null> {
    boundedDatabaseIdentifier(groupKey, "groupKey");
    return this.database.transaction({ requestId, operation: "apple.seat-group.read" }, async (tx) => {
      const rows = await tx.query<{ space_id: string }>({ name: "apple_seat_group_space_v1",
        text: "SELECT space_id FROM control.apple_seat_groups WHERE environment=$1 AND group_key=$2",
        values: [environment, groupKey], maxRows: 1 });
      return rows[0]?.space_id ?? null;
    });
  }

  /** Refresh a seat Apple notified about; null when no one has restored it yet. */
  async refreshAssignedSeat(requestId: string, input: AppleAssignedSeat): Promise<AppleSeatGroupState | null> {
    const seat = this.seat(input);
    return this.database.transaction({ requestId, operation: "apple.assigned-seat.refresh" }, async (tx) => {
      const rows = await tx.query<{ user_id: string; group_key: string }>({ name: "apple_assigned_seat_refresh_v1",
        text: `UPDATE control.apple_assigned_seats SET product_id=$3, expires_at=$4, active=$5, signed_at=$6, updated_at=clock_timestamp()
          WHERE environment=$1 AND original_transaction_id=$2 AND signed_at <= $6 RETURNING user_id,group_key`,
        values: [seat.environment, seat.originalTransactionId, seat.productId, seat.expiresAt, seat.active, seat.signedAt], maxRows: 1 });
      const known = rows[0] ?? (await tx.query<{ user_id: string; group_key: string }>({ name: "apple_assigned_seat_read_v1",
        text: "SELECT user_id,group_key FROM control.apple_assigned_seats WHERE environment=$1 AND original_transaction_id=$2",
        values: [seat.environment, seat.originalTransactionId], maxRows: 1 }))[0];
      return known ? this.groupState(tx, seat.environment, known.group_key, known.user_id) : null;
    });
  }

  private seat(input: AppleAssignedSeat): AppleAssignedSeat {
    boundedDatabaseIdentifier(input.originalTransactionId, "originalTransactionId");
    if (!/^[0-9]{1,100}$/.test(input.originalTransactionId) || !["Production", "Sandbox"].includes(input.environment) ||
        !/^[A-Za-z0-9._-]{1,200}$/.test(input.productId) || !Number.isFinite(Date.parse(input.expiresAt)) ||
        !Number.isFinite(Date.parse(input.signedAt)) || typeof input.active !== "boolean") {
      throw new BillingControlError("invalid_apple_transaction", 400, "Invalid Apple assigned seat");
    }
    return input;
  }

  private async groupState(tx: DatabaseTransaction, environment: string, groupKey: string,
    userId: string): Promise<AppleSeatGroupState> {
    const rows = await tx.query<{ space_id: string; owner_user_id: string | null; holder_role: string | null; active_seats: string | number;
      product_id: string | null; period_end: Date | string | null }>({ name: "apple_seat_group_state_v1",
      text: `SELECT g.space_id,
          (SELECT m.user_id FROM control.user_space_memberships m WHERE m.space_id=g.space_id AND m.role='owner' LIMIT 1) AS owner_user_id,
          (SELECT m.role FROM control.user_space_memberships m WHERE m.space_id=g.space_id AND m.user_id=$3 LIMIT 1) AS holder_role,
          (SELECT COUNT(*) FROM control.apple_assigned_seats s WHERE s.environment=g.environment AND s.group_key=g.group_key
            AND s.active AND s.expires_at > clock_timestamp()) AS active_seats,
          (SELECT s.product_id FROM control.apple_assigned_seats s WHERE s.environment=g.environment AND s.group_key=g.group_key
            ORDER BY s.signed_at DESC LIMIT 1) AS product_id,
          (SELECT max(s.expires_at) FROM control.apple_assigned_seats s WHERE s.environment=g.environment AND s.group_key=g.group_key) AS period_end
        FROM control.apple_seat_groups g WHERE g.environment=$1 AND g.group_key=$2`,
      values: [environment, groupKey, userId], maxRows: 1 });
    const row = rows[0];
    if (!row?.owner_user_id || !row.product_id || !row.period_end) throw new BillingControlError(
      "apple_seat_space_unavailable", 409, "The Space for these App Store seats has no owner");
    return { groupKey, spaceId: row.space_id, ownerUserId: row.owner_user_id, holderRole: row.holder_role,
      activeSeats: Number(row.active_seats), productId: row.product_id, periodEnd: new Date(row.period_end).toISOString() };
  }
}

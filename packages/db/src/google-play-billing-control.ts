import type { AuthorityDatabase } from "./contracts.js";
import { BillingControlError, PostgresBillingRepository } from "./billing-control.js";
import { accountRevokedSql } from "./account-deletion.js";
import { reserveStorePurchase } from "./store-purchase-tokens.js";

export type GooglePlayEnvironment = "Production" | "Test";

export interface GooglePlayAccountBinding {
  accountToken: string;
  spaceId: string;
  ownerUserId: string;
  accountDeleted: boolean;
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

/** Immutable global purchase identity; this table does not grant entitlements. */
export class PostgresGooglePlayBillingRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly billing: PostgresBillingRepository) {
    if (database.cacheMode !== "disabled") throw new BillingControlError("cached_authority_forbidden", 500, "Google Play billing requires uncached authority");
  }

  async prepare(input: { requestId: string; commandId: string; spaceId: string; actorUserId: string; interval: "month" | "year"; productId: string }) {
    const accountToken = await reserveStorePurchase(this.database, this.billing, { provider: "google", table: "control.google_play_account_tokens",
      column: "account_token", statement: "google_play_account_token_create_v1", operation: "google-play.purchase.prepare" }, input);
    return { accountToken };
  }

  async resolve(requestId: string, token: string): Promise<GooglePlayAccountBinding | null> {
    if (!UUID.test(token)) return null;
    return this.database.transaction({ requestId, operation: "google-play.purchase.resolve" }, async (tx) => {
      const rows = await tx.query<{ account_token: string; space_id: string; owner_user_id: string; account_deleted: boolean }>({
        name: "google_play_account_token_read_v1", text: `SELECT t.account_token,t.space_id,t.owner_user_id,
          ${accountRevokedSql("t.owner_user_id")} AS account_deleted
          FROM control.google_play_account_tokens t WHERE t.account_token=$1 LIMIT 1`, values: [token], maxRows: 1,
      });
      const row = rows[0];
      return row ? { accountToken: row.account_token, spaceId: row.space_id, ownerUserId: row.owner_user_id, accountDeleted: row.account_deleted } : null;
    });
  }

  /** Bind a purchase token to its account token for good; a second account is refused. */
  async claim(requestId: string, environment: GooglePlayEnvironment, purchaseTokenDigest: string, token: string): Promise<void> {
    if (!["Production", "Test"].includes(environment) || !/^[0-9a-f]{64}$/.test(purchaseTokenDigest) || !UUID.test(token)) {
      throw new BillingControlError("invalid_google_play_purchase", 400, "Invalid Google Play purchase identifier");
    }
    await this.database.transaction({ requestId, operation: "google-play.subscription.claim" }, async (tx) => {
      await tx.query({ name: "google_play_purchase_claim_v1", text: `INSERT INTO control.google_play_purchase_bindings
        (environment,purchase_token_digest,account_token) VALUES ($1,$2,$3)
        ON CONFLICT (environment,purchase_token_digest) DO NOTHING`, values: [environment, purchaseTokenDigest, token], maxRows: 0 });
      const rows = await tx.query<{ account_token: string }>({ name: "google_play_purchase_binding_v1",
        text: `SELECT account_token FROM control.google_play_purchase_bindings
          WHERE environment=$1 AND purchase_token_digest=$2 FOR UPDATE`, values: [environment, purchaseTokenDigest], maxRows: 1 });
      if (rows[0]?.account_token.toLowerCase() !== token.toLowerCase()) throw new BillingControlError(
        "google_play_subscription_bound_elsewhere", 409, "This Google Play subscription is already bound to another Space; rebinding is not supported");
    });
  }
}

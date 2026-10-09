import type { AuthorityDatabase } from "./contracts.js";
import { BillingControlError, PostgresBillingRepository } from "./billing-control.js";
import { boundedDatabaseIdentifier } from "./identifiers.js";

export interface AppleAccountBinding {
  appAccountToken: string;
  spaceId: string;
  ownerUserId: string;
  accountDeleted: boolean;
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
        name: "apple_account_token_read_v2", text: `SELECT t.app_account_token,t.space_id,t.owner_user_id,
          EXISTS (SELECT 1 FROM control.account_deletion_requests d WHERE d.user_id=t.owner_user_id
            AND d.state IN ('committed','completed')) AS account_deleted
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
}

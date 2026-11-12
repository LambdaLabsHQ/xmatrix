import type { AuthorityDatabase } from "./contracts.js";
import type { BillingProvider, PostgresBillingRepository } from "./billing-control.js";

/** Where one app store keeps its global purchase-owner tokens. */
export interface StoreTokenTable {
  provider: Exclude<BillingProvider, "stripe">;
  table: "control.apple_account_tokens" | "control.google_play_account_tokens";
  column: "app_account_token" | "account_token";
  statement: string;
  operation: string;
}

/**
 * Reserve a one-seat store checkout for the Space owner, then return the
 * stable token the store carries with the purchase. The Space transaction
 * verifies the owner, one human seat and any provider conflict first.
 */
export async function reserveStorePurchase(database: AuthorityDatabase, billing: PostgresBillingRepository, store: StoreTokenTable,
  input: { requestId: string; commandId: string; spaceId: string; actorUserId: string; interval: "month" | "year"; productId: string }): Promise<string> {
  await billing.createCheckoutIntent({ ...input, priceId: input.productId, seatQuantity: 1, billingProvider: store.provider });
  return database.transaction({ requestId: input.requestId, operation: store.operation }, async (tx) => {
    const rows = await tx.query<Record<string, string>>({
      name: store.statement,
      text: `INSERT INTO ${store.table}(${store.column},space_id,owner_user_id)
        VALUES ($1,$2,$3) ON CONFLICT (space_id,owner_user_id)
        DO UPDATE SET space_id=EXCLUDED.space_id RETURNING ${store.column}`,
      values: [crypto.randomUUID(), input.spaceId, input.actorUserId], maxRows: 1,
    });
    return rows[0][store.column];
  });
}

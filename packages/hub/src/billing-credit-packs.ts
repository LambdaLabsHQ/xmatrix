import { PostgresCreditPackRepository, type CreditPackPayment } from "@xmatrix/db";
import type { Env } from "./types";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";
import { StripeBillingError, retrieveStripeCheckoutSession } from "./billing-stripe";

export function creditPackRepository(env: Env): PostgresCreditPackRepository {
  return new PostgresCreditPackRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-credit-packs", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }), postgresAuthorityShardId(env, "billing"));
}

/** The provider read, never the browser or webhook snapshot, proves payment. */
export function creditPackPayment(session: Record<string, unknown>): CreditPackPayment {
  const metadata = session.metadata as Record<string, unknown> | undefined;
  if (session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid" ||
    metadata?.xmatrix_purchase_kind !== "credit_pack" || session.currency !== "usd" || session.amount_subtotal !== 1_000 ||
    typeof session.id !== "string" || typeof metadata.xmatrix_space_id !== "string" ||
    typeof metadata.xmatrix_billing_owner_user_id !== "string" || typeof metadata.xmatrix_checkout_intent_id !== "string" ||
    session.client_reference_id !== metadata.xmatrix_checkout_intent_id) {
    throw new StripeBillingError("Credit pack payment could not be verified");
  }
  return { sessionId: session.id, spaceId: metadata.xmatrix_space_id,
    ownerUserId: metadata.xmatrix_billing_owner_user_id, purchaseId: metadata.xmatrix_checkout_intent_id,
    amountCents: session.amount_subtotal, currency: session.currency };
}

export async function settleCreditPack(env: Env, sessionId: string, owner?: { spaceId: string; userId: string }) {
  const payment = creditPackPayment(await retrieveStripeCheckoutSession(env.STRIPE_SECRET_KEY!, sessionId));
  if (owner && (payment.spaceId !== owner.spaceId || payment.ownerUserId !== owner.userId)) {
    throw new StripeBillingError("Credit pack payment belongs to another Space or owner");
  }
  return creditPackRepository(env).settle(crypto.randomUUID(), payment);
}

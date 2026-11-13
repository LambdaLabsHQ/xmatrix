"use client";

import { useCallback } from "react";
import type { GooglePlayPurchase } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { actionClass } from "@/components/ui/action-tone";
import { StoreBillingFrame, useStoreCatalog, useStoreSection, useStorePurchaseRecovery } from "./store-billing";

type Catalog = { subscriptionId: string; products: { basePlanId: string; interval: "month" | "year" }[] };
type Product = { subscriptionId: string; basePlanId: string; interval: "month" | "year"; displayPrice: string };

/** Pro bought through Google Play, inside the Android app; the Hub verifies every purchase with Google. */
export function GooglePlaySpaceBillingSection({ userId, space }: { userId: string; space: { id: string; name: string } | null }) {
  const { bridge, billing, base, spaceId, refreshBilling, busy, message, setMessage, run } = useStoreSection(userId, space, "google-play");
  const available = Boolean(bridge?.googlePlayProducts && bridge.googlePlayPurchase && bridge.googlePlayPurchases && bridge.googlePlayManage);
  const products = useStoreCatalog<Product>(`${base}|${available}`, base && available ? async () => {
    const catalog = await xmatrixApiRequest<Catalog>({ url: base });
    const loaded = await bridge!.googlePlayProducts!({ subscriptionId: catalog.subscriptionId });
    return catalog.products.flatMap((product) => {
      const play = loaded.find((item) => item.basePlanId === product.basePlanId);
      return play ? [{ ...product, subscriptionId: catalog.subscriptionId, displayPrice: play.displayPrice }] : [];
    });
  } : null, "Couldn't load Google Play subscriptions", setMessage);
  const subscriptionId = products[0]?.subscriptionId ?? "";

  const reconcile = useCallback(async (purchase: GooglePlayPurchase) => {
    if (!spaceId) return;
    // The Hub verifies the token with Google and acknowledges it there.
    await xmatrixApiRequest({ url: `${base}/reconcile`, method: "POST", body: { purchaseToken: purchase.purchaseToken } });
    await refreshBilling();
  }, [base, refreshBilling, spaceId]);

  // A purchase approved while the app was away (a pending payment, a closed
  // app) is verified when Billing is opened or comes back to front.
  const recover = useCallback(async (disposed: () => boolean) => {
    const purchases = await bridge?.googlePlayPurchases?.({ subscriptionId });
    for (const item of purchases ?? []) {
      if (disposed()) break;
      if (item.state !== "purchased") continue;
      try { await reconcile(item); } catch { /* Another Space's binding is never moved. */ }
    }
  }, [bridge, subscriptionId, reconcile]);
  useStorePurchaseRecovery(Boolean(base && subscriptionId && billing?.canManage), recover);

  function purchase(product: Product) {
    if (busy || !space) return;
    void run(async () => {
      const prepared = await xmatrixApiRequest<{ accountToken: string; subscriptionId: string; basePlanId: string }>({
        url: `${base}/prepare`, method: "POST", body: { interval: product.interval } });
      const result = await bridge!.googlePlayPurchase!(prepared);
      if (result.status === "purchased" && result.purchase) {
        await reconcile(result.purchase);
        return `Purchase verified. The plan for ${space.name} has been refreshed.`;
      }
      return result.status === "pending" ? "Google Play is waiting for the payment to complete. Your plan updates after it does." : "Purchase cancelled. No plan change was made.";
    }, "Couldn't complete the purchase");
  }

  function restore() {
    if (busy || !subscriptionId) return;
    void run(async () => {
      const purchases = (await bridge!.googlePlayPurchases!({ subscriptionId })).filter((item) => item.state === "purchased");
      for (const item of purchases) await reconcile(item);
      return purchases.length ? "Purchases checked. The original Space binding is unchanged." : "No current Google Play subscription was found.";
    }, "Couldn't restore the purchase");
  }

  if (!space) return <p>Open a Space to see its plan.</p>;
  if (!available) return <p>Update xMatrix from Google Play to manage subscriptions. Existing Space access is unchanged.</p>;
  const google = billing?.subscription?.billingProvider === "google";
  return <StoreBillingFrame testId="google-play-billing" storeName="Google Play" provider="google" userId={userId} space={space} billing={billing}
    coverage="Google Play Pro covers one human seat and 5,000 Agent credits each month for Agent/app writing and paid X actions; people write in xMatrix for free. Agents do not occupy seats. Model-provider subscriptions are separate."
    products={products.map((product) => ({ key: product.basePlanId, displayPrice: product.displayPrice, interval: product.interval }))}
    busy={busy} onPurchase={(key) => { const product = products.find((item) => item.basePlanId === key); if (product) purchase(product); }}
    terms="Payment is charged to your Google Play account. Subscriptions renew automatically until cancelled in Google Play; cancelling keeps Pro until the end of the paid period."
    message={message} actions={<>
      <button className={actionClass({ variant: "secondary", size: "md" })} disabled={busy || !subscriptionId || !billing?.canManage} onClick={restore}>Restore purchases</button>
      {google && billing?.canManage && <button className={actionClass({ variant: "secondary", size: "md" })} disabled={busy}
        onClick={() => void bridge?.googlePlayManage?.({ subscriptionId }).catch(() => setMessage("Open Google Play subscriptions to manage renewal."))}>Manage subscription</button>}
    </>} />;
}

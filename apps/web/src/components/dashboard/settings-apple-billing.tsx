"use client";

import { useCallback } from "react";
import type { ApplePurchaseTransaction } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { actionClass } from "@/components/ui/action-tone";
import { StoreBillingFrame, useStoreCatalog, useStoreSection, useStorePurchaseRecovery } from "./store-billing";

type Product = { id: string; interval: "month" | "year"; displayName: string; displayPrice: string };

export function AppleSpaceBillingSection({ userId, space }: { userId: string; space: { id: string; name: string } | null }) {
  const { bridge, billing, base, spaceId, refreshBilling, busy, message, setMessage, run } = useStoreSection(userId, space, "apple");
  const available = Boolean(bridge?.applePurchase && bridge.appleProducts && bridge.applePurchases && bridge.appleFinish);
  const products = useStoreCatalog<Product>(`${base}|${available}`, base && available ? async () => {
    const catalog = await xmatrixApiRequest<{ products: { id: string; interval: "month" | "year" }[] }>({ url: base });
    const loaded = await bridge!.appleProducts!(catalog.products.map((product) => product.id));
    return catalog.products.flatMap((product) => {
      const apple = loaded.find((item) => item.id === product.id);
      return apple ? [{ ...product, displayName: apple.displayName, displayPrice: apple.displayPrice }] : [];
    });
  } : null, "Couldn't load App Store products", setMessage);

  const reconcile = useCallback(async (transaction: ApplePurchaseTransaction) => {
    if (!spaceId) return;
    await xmatrixApiRequest({ url: `${base}/reconcile`, method: "POST", body: {
      originalTransactionId: transaction.originalTransactionId, environment: transaction.environment,
    } });
    // A failed server verification leaves StoreKit's transaction unfinished.
    await bridge!.appleFinish!(transaction.transactionId);
    await refreshBilling();
  }, [base, bridge, refreshBilling, spaceId]);

  // Recover an approved pending purchase without asking Apple to authenticate
  // again. Explicit Restore below is the only path that calls AppStore.sync.
  const recover = useCallback(async (disposed: () => boolean) => {
    const transactions = await bridge?.applePurchases?.({ productIds: products.map((item) => item.id), restore: false });
    for (const transaction of transactions ?? []) {
      if (disposed()) break;
      try { await reconcile(transaction); } catch { /* Another Space's binding is never moved. */ }
    }
  }, [bridge, products, reconcile]);
  useStorePurchaseRecovery(Boolean(base && products.length && billing?.canManage), recover);

  function purchase(product: Product) {
    if (busy || !space) return;
    void run(async () => {
      const prepared = await xmatrixApiRequest<{ productId: string; appAccountToken: string }>({ url: `${base}/prepare`, method: "POST", body: { interval: product.interval } });
      const result = await bridge!.applePurchase!({ ...prepared, productIds: products.map((item) => item.id) });
      if (result.status === "purchased" && result.transaction) {
        await reconcile(result.transaction);
        return `Purchase verified. The plan for ${space.name} has been refreshed.`;
      }
      return result.status === "pending" ? "Apple is awaiting purchase approval. Your plan updates after confirmation." : "Purchase cancelled. No plan change was made.";
    }, "Couldn't complete the purchase");
  }

  function restore() {
    if (busy) return;
    void run(async () => {
      const transactions = await bridge!.applePurchases!({ productIds: products.map((item) => item.id), restore: true });
      for (const transaction of transactions) await reconcile(transaction);
      return transactions.length ? "Purchases checked. The original Space binding is unchanged." : "No current App Store subscription was found.";
    }, "Couldn't restore the purchase");
  }

  if (!space) return <p>Open a Space to see its plan.</p>;
  if (!available) return <p>Update xMatrix to manage App Store subscriptions. Existing Space access is unchanged.</p>;
  const apple = billing?.subscription?.billingProvider === "apple";
  return <StoreBillingFrame testId="apple-billing" storeName="App Store" provider="apple" space={space} billing={billing}
    coverage="App Store Pro covers as many human seats as were bought through the App Store (a purchase here is one seat) and 5,000 Agent credits per seat each month for Agent/app writing and paid X actions; people write in xMatrix for free. Agents do not occupy seats. Model-provider subscriptions are separate."
    products={products.map((product) => ({ key: product.id, displayPrice: product.displayPrice, interval: product.interval }))}
    busy={busy} onPurchase={(key) => { const product = products.find((item) => item.id === key); if (product) purchase(product); }}
    terms="Payment is charged to your Apple Account after confirmation. Subscriptions renew automatically unless cancelled at least 24 hours before the current period ends. Manage renewal in your Apple Account subscription settings."
    message={message} actions={<>
      <button className={actionClass({ variant: "secondary", size: "md" })} disabled={busy || !products.length || !billing?.canManage} onClick={restore}>Restore purchases</button>
      {apple && billing?.canManage && <button className={actionClass({ variant: "secondary", size: "md" })} disabled={busy} onClick={() => void bridge?.appleManage?.().catch(() => setMessage("Open App Store subscription settings to manage renewal."))}>Manage subscription</button>}
    </>} />;
}

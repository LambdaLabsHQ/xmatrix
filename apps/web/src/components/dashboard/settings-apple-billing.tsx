"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getDesktopBridge, type ApplePurchaseTransaction } from "@/lib/desktop/bridge";
import { userErrorMessage } from "@/lib/user-facing-error";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { actionClass } from "@/components/ui/action-tone";
import { useSpaceBilling } from "./settings-billing";

type Product = { id: string; interval: "month" | "year"; displayName: string; displayPrice: string };

export function AppleSpaceBillingSection({ userId, space }: { userId: string; space: { id: string; name: string } | null }) {
  const bridge = getDesktopBridge();
  const billing = useSpaceBilling(userId, space?.id ?? null).data;
  const queries = useQueryClient();
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const available = Boolean(bridge?.applePurchase && bridge.appleProducts && bridge.applePurchases && bridge.appleFinish);
  const spaceId = space?.id;
  const base = space ? `/api/xmatrix/spaces/${encodeURIComponent(space.id)}/billing/apple` : "";

  useEffect(() => {
    let current = true;
    setProducts([]);
    setMessage("");
    if (!base || !available) return;
    void (async () => {
      try {
        const catalog = await xmatrixApiRequest<{ products: { id: string; interval: "month" | "year" }[] }>({ url: base });
        const loaded = await bridge!.appleProducts!(catalog.products.map((product) => product.id));
        if (current) setProducts(catalog.products.flatMap((product) => {
          const apple = loaded.find((item) => item.id === product.id);
          return apple ? [{ ...product, displayName: apple.displayName, displayPrice: apple.displayPrice }] : [];
        }));
      } catch (error) { if (current) setMessage(userErrorMessage(error, "Couldn't load App Store products") ?? ""); }
    })();
    return () => { current = false; };
  }, [available, base, bridge]);

  const reconcile = useCallback(async (transaction: ApplePurchaseTransaction) => {
    if (!spaceId) return;
    await xmatrixApiRequest({ url: `${base}/reconcile`, method: "POST", body: {
      originalTransactionId: transaction.originalTransactionId, environment: transaction.environment,
    } });
    // A failed server verification leaves StoreKit's transaction unfinished.
    await bridge!.appleFinish!(transaction.transactionId);
    await queries.invalidateQueries({ queryKey: xmatrixQueryKeys.domain({ userId }, "billing", [spaceId]) });
  }, [base, bridge, queries, spaceId, userId]);

  useEffect(() => {
    if (!base || !products.length || !billing?.canManage) return;
    // Recover an approved pending purchase without asking Apple to authenticate
    // again. Explicit Restore below is the only path that calls AppStore.sync.
    let running = false;
    let disposed = false;
    const recover = async () => {
      if (running || disposed || document.visibilityState === "hidden") return;
      running = true;
      try {
        const transactions = await bridge?.applePurchases?.({ productIds: products.map((item) => item.id), restore: false });
        for (const transaction of transactions ?? []) {
          if (disposed) break;
          try { await reconcile(transaction); } catch { /* Another Space's binding is never moved. */ }
        }
      } catch { /* Explicit Restore displays actionable errors. */ }
      finally { running = false; }
    };
    void recover();
    const onResume = () => { void recover(); };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [base, products, billing?.canManage, bridge, reconcile]);

  async function purchase(product: Product) {
    if (busy || !space) return;
    setBusy(true); setMessage("");
    try {
      const prepared = await xmatrixApiRequest<{ productId: string; appAccountToken: string }>({ url: `${base}/prepare`, method: "POST", body: { interval: product.interval } });
      const result = await bridge!.applePurchase!({ ...prepared, productIds: products.map((item) => item.id) });
      if (result.status === "purchased" && result.transaction) {
        await reconcile(result.transaction);
        setMessage(`Purchase verified. The plan for ${space.name} has been refreshed.`);
      } else setMessage(result.status === "pending" ? "Apple is awaiting purchase approval. Your plan updates after confirmation." : "Purchase cancelled. No plan change was made.");
    } catch (error) { setMessage(userErrorMessage(error, "Couldn't complete the purchase") ?? ""); }
    finally { setBusy(false); }
  }

  async function restore() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const transactions = await bridge!.applePurchases!({ productIds: products.map((item) => item.id), restore: true });
      for (const transaction of transactions) await reconcile(transaction);
      setMessage(transactions.length ? "Purchases checked. The original Space binding is unchanged." : "No current App Store subscription was found.");
    } catch (error) { setMessage(userErrorMessage(error, "Couldn't restore the purchase") ?? ""); }
    finally { setBusy(false); }
  }

  if (!space) return <p>Open a Space to see its plan.</p>;
  if (!available) return <p>Update xMatrix to manage App Store subscriptions. Existing Space access is unchanged.</p>;
  const active = billing?.plan === "pro";
  const apple = billing?.subscription?.billingProvider === "apple";
  const canPurchase = billing?.canManage && billing.seats.used === 1 && !active &&
    (!billing.subscription || ["canceled", "incomplete_expired"].includes(billing.subscription.status));
  return <div className="app-settings-section space-y-4" data-testid="apple-billing">
    <div><h3 className="font-semibold">{space.name}</h3><p>{active ? "Pro" : "Free"} · {billing?.seats.used ?? "–"} human seats</p></div>
    <p>App Store Pro includes one human seat and unmetered collaboration messages. Agents do not occupy seats. Model-provider subscriptions are separate.</p>
    <p>The subscription is bound to this Space. Switching Spaces or restoring purchases does not move it. Rebinding is not supported.</p>
    {canPurchase && <div className="flex flex-wrap gap-2">{products.map((product) => <button key={product.id} disabled={busy}
      className={actionClass({ variant: "primary", size: "md" })} onClick={() => void purchase(product)}>
      {product.displayPrice} / {product.interval === "month" ? "month" : "year"}
    </button>)}</div>}
    {!canPurchase && !active && <p>Only the owner of a Space with one human seat and no existing subscription can purchase App Store Pro.</p>}
    {active && !apple && <p>This Space already has a subscription managed by its owner.</p>}
    <div className="flex flex-wrap gap-2">
      <button className={actionClass({ variant: "secondary", size: "md" })} disabled={busy || !products.length || !billing?.canManage} onClick={() => void restore()}>Restore purchases</button>
      {apple && billing?.canManage && <button className={actionClass({ variant: "secondary", size: "md" })} disabled={busy} onClick={() => void bridge?.appleManage?.().catch(() => setMessage("Open App Store subscription settings to manage renewal."))}>Manage subscription</button>}
    </div>
    <p className="text-xs text-muted-foreground">Payment is charged to your Apple Account after confirmation. Subscriptions renew automatically unless cancelled at least 24 hours before the current period ends. Manage renewal in your Apple Account subscription settings.</p>
    <div className="flex gap-4 text-sm"><Link href="/terms">Terms of Service</Link><Link href="/privacy">Privacy Policy</Link></div>
    {message && <p role="status">{message}</p>}
  </div>;
}

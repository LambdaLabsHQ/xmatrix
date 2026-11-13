"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientDefectAction } from "@xmatrix/protocol";
import { userErrorMessage } from "@/lib/user-facing-error";
import { actionClass } from "@/components/ui/action-tone";
import { useQueryClient } from "@tanstack/react-query";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { useSpaceBilling } from "./space-billing";
import { allowanceUsed, SpaceUsage } from "./space-usage";

/**
 * Busy and status for a store's Billing section: one store action runs at a
 * time, and what it reports (or why it failed) is the section's message.
 */
export function useStoreAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const run = useCallback(async (action: () => Promise<string>, failure: ClientDefectAction) => {
    setBusy(true); setMessage("");
    try { setMessage(await action()); }
    catch (error) { setMessage(userErrorMessage(error, failure) ?? ""); }
    finally { setBusy(false); }
  }, []);
  return { busy, message, setMessage, run };
}

/** What a store's Billing section reads: the app bridge, the Space's plan and its store routes. */
export function useStoreSection(userId: string, space: { id: string } | null, store: "apple" | "google-play") {
  const bridge = getDesktopBridge();
  const billing = useSpaceBilling(userId, space?.id ?? null).data;
  const queries = useQueryClient();
  const spaceId = space?.id;
  const base = spaceId ? `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing/${store}` : "";
  const refreshBilling = useCallback(async () => {
    if (spaceId) await queries.invalidateQueries({ queryKey: xmatrixQueryKeys.domain({ userId }, "billing", [spaceId]) });
  }, [queries, spaceId, userId]);
  return { bridge, billing, base, spaceId, refreshBilling, ...useStoreAction() };
}

/** The store's products for this Space, reloaded when the Space or bridge changes. */
export function useStoreCatalog<T>(key: string, load: (() => Promise<T[]>) | null, failure: ClientDefectAction,
  setMessage: (message: string) => void): T[] {
  const [products, setProducts] = useState<T[]>([]);
  // The key names the Space and bridge the loader reads; the latest loader runs.
  const latest = useRef({ load, failure, setMessage });
  latest.current = { load, failure, setMessage };
  useEffect(() => {
    const { load, failure, setMessage } = latest.current;
    let current = true;
    setProducts([]);
    setMessage("");
    if (!load) return;
    void load().then((loaded) => { if (current) setProducts(loaded); },
      (error) => { if (current) setMessage(userErrorMessage(error, failure) ?? ""); });
    return () => { current = false; };
  }, [key]);
  return products;
}

type Billing = NonNullable<ReturnType<typeof useSpaceBilling>["data"]>;

/**
 * Run `recover` when Billing opens and whenever the app comes back to front:
 * a store purchase approved while the app was away is verified then, without
 * asking the store to authenticate again.
 */
export function useStorePurchaseRecovery(enabled: boolean, recover: (disposed: () => boolean) => Promise<void>) {
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    let disposed = false;
    const run = async () => {
      if (running || disposed || document.visibilityState === "hidden") return;
      running = true;
      try { await recover(() => disposed); }
      catch { /* Explicit Restore displays actionable errors. */ }
      finally { running = false; }
    };
    void run();
    const onResume = () => { void run(); };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [enabled, recover]);
}

/** Whether this person may buy a one-seat store subscription for this Space now. */
export function canPurchaseFromStore(billing: Billing | undefined): boolean {
  return Boolean(billing?.canManage && billing.seats.used === 1 && billing.plan !== "pro" &&
    (!billing.subscription || ["canceled", "incomplete_expired"].includes(billing.subscription.status)));
}

/**
 * What every store's Billing section says the same way: the Space's plan, the
 * immutable binding, the period buttons and the legal links. Each store adds
 * only its own name, buttons and renewal terms.
 */
export function StoreBillingFrame({ testId, storeName, provider, userId, space, billing, coverage, products, busy, onPurchase, actions, terms, message }: {
  testId: string; storeName: string; provider: "apple" | "google"; userId: string; space: { name: string }; billing: Billing | undefined; coverage: string;
  products: { key: string; displayPrice: string; interval: "month" | "year" }[]; busy: boolean;
  onPurchase: (key: string) => void; actions: React.ReactNode; terms: string; message: string;
}) {
  const active = billing?.plan === "pro";
  const canPurchase = canPurchaseFromStore(billing);
  return <div className="app-settings-section space-y-4" data-testid={testId}>
    <div><h3 className="font-semibold">{space.name}</h3><p>{active ? "Pro" : "Free"} · {billing ? `${billing.seats.used} / ${billing.seats.limit}` : "–"} human seats</p></div>
    {billing && <StoreAllowance billing={billing} userId={userId} />}
    <p>{coverage}</p>
    <p>The subscription is bound to this Space. Switching Spaces or restoring purchases does not move it. Rebinding is not supported.</p>
    {canPurchase && <div className="flex flex-wrap gap-2">{products.map((product) => <button key={product.key} disabled={busy}
      className={actionClass({ variant: "primary", size: "md" })} onClick={() => onPurchase(product.key)}>
      {product.displayPrice} / {product.interval === "month" ? "month" : "year"}
    </button>)}</div>}
    {!canPurchase && !active && <p>Only the owner of a Space with one human seat and no existing subscription can purchase {storeName} Pro.</p>}
    {active && billing?.subscription?.billingProvider !== provider && <p>This Space already has a subscription managed by its owner.</p>}
    <div className="flex flex-wrap gap-2">{actions}</div>
    <p className="text-xs text-muted-foreground">{terms}</p>
    <div className="flex gap-4 text-sm"><Link href="/terms">Terms of Service</Link><Link href="/privacy">Privacy Policy</Link></div>
    {message && <p role="status">{message}</p>}
  </div>;
}

/** The allowance the Space is using and who used it, as Settings → Billing shows on the web. */
function StoreAllowance({ billing, userId }: { billing: Billing; userId: string }) {
  const limit = billing.plan === "pro" && billing.credits ? billing.credits.included : billing.freeUsage.limit;
  return <div className="space-y-3">
    <p>{billing.plan === "pro" && billing.credits ? "Agent credits this month" : "Messages & page edits"}:{" "}
      <span className="tabular-nums">{allowanceUsed(billing).toLocaleString()} of {limit.toLocaleString()}</span>
      {billing.usage?.waived ? " (not charged)" : ""}</p>
    <SpaceUsage billing={billing} userId={userId} />
  </div>;
}

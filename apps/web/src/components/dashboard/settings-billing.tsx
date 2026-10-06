"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { noticeClass, statusChipClass } from "@/components/ui/status-tone";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { LiquidGlassCard, WoodPanel } from "@/components/ui/material-surfaces";
import { PRO_PLAN_FEATURES, PRO_SEAT_PRICE_USD } from "@/lib/space-plans";
import { billingCheckoutReturn } from "@/lib/billing-checkout-return";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";
import { spacePlanMark, spacePlansAbsent, type SpacePlanBilling } from "./space-plan-mark";
import { replaceBrowserPath } from "./workspace-shell-navigation";

export const SPACE_BILLING_SECTION = "billing";

/** The return parameters `/billing` forwards; removed once they have been acted on. */
const CHECKOUT_RETURN_PARAMS = ["checkout", "checkout_session_id", "ai_checkout", "ai_checkout_session_id"] as const;

export type SpaceBilling = SpacePlanBilling & {
  plan: "free" | "pro";
  canManage: boolean;
  seats: { used: number; limit: number };
  freeUsage: { acceptedMessages: number; limit: number; remaining: number };
  subscription: {
    status: string;
    seatQuantity: number;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil?: string;
    access?: "full" | "read_only";
  } | null;
  seatAdjustmentRequired?: boolean;
};

function capitalized(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1).replace(/_/g, " ") : value;
}

/** The return parameters in the address when this section opened. Read once. */
function useCheckoutReturn() {
  const [returned] = useState(() => billingCheckoutReturn(
    new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
  ));
  const clear = useCallback(() => {
    const url = new URL(window.location.href);
    if (!CHECKOUT_RETURN_PARAMS.some((name) => url.searchParams.has(name))) return;
    for (const name of CHECKOUT_RETURN_PARAMS) url.searchParams.delete(name);
    replaceBrowserPath(`${url.pathname}${url.search}${url.hash}`);
  }, []);
  return useMemo(() => ({ ...returned, clear }), [returned, clear]);
}

function spaceBillingKey(userId: string, spaceId: string) {
  // The plan badge reads under this same key, so a checkout that writes the
  // fresher summary here updates the badge beside the Space name with it.
  return xmatrixQueryKeys.domain({ userId }, "billing", [spaceId]);
}

export function useSpaceBilling(userId: string, spaceId: string | null) {
  return useQuery({
    queryKey: spaceBillingKey(userId, spaceId ?? ""),
    queryFn: ({ signal }) => xmatrixApiRequest<{ billing: SpaceBilling }>({
      url: `/api/xmatrix/spaces/${encodeURIComponent(spaceId!)}/billing`, signal,
    }).then((payload) => payload.billing),
    enabled: Boolean(spaceId),
    retry: (failures, error) => !spacePlansAbsent(error) && failures < 3,
  });
}

/** The list row's summary: the plan, and what is wrong with it if anything is. */
export function spaceBillingSummary(billing: SpaceBilling | undefined): string {
  if (!billing) return "Space plan and seats";
  const mark = spacePlanMark(billing);
  const seats = `${billing.seats.used} / ${billing.seats.limit} seats`;
  if (!mark || mark.state === "active") return `${mark?.label ?? capitalized(billing.plan)} · ${seats}`;
  return mark.title;
}

/** A billing date. Plans renew and end on a day, so the day is all it says. */
function formatPlanDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SectionError({ error }: { error: string }) {
  return error ? <p role="alert" className={noticeClass("alert", "mt-3")}>{error}</p> : null;
}

export function SpaceBillingSection({ userId, space }: {
  userId: string;
  space: { id: string; name: string } | null;
}) {
  const queryClient = useQueryClient();
  const spaceId = space?.id ?? null;
  const billingQuery = useSpaceBilling(userId, spaceId);
  const billing = billingQuery.data ?? null;
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [seats, setSeats] = useState(1);
  const returned = useCheckoutReturn();
  const reconciled = useRef<string | null>(null);
  const command = useMutation({
    mutationKey: [...spaceBillingKey(userId, spaceId ?? ""), "command"],
    mutationFn: (input: { kind: "checkout" | "portal" | "reconcile"; body?: unknown }) =>
      xmatrixApiRequest<{ checkoutUrl?: string; portalUrl?: string; billing?: SpaceBilling }>({
        url: `/api/xmatrix/spaces/${encodeURIComponent(spaceId!)}/billing/${input.kind}`,
        method: "POST",
        body: input.body,
      }),
    onSuccess: (payload) => {
      if (payload.billing) queryClient.setQueryData(spaceBillingKey(userId, spaceId ?? ""), payload.billing);
    },
  });
  const busy = command.isPending ? command.variables?.kind ?? null : null;
  const error = (command.error ?? billingQuery.error)?.message ?? "";

  useEffect(() => {
    if (billing) setSeats(Math.max(1, billing.seats.used));
  }, [billing]);

  const run = useCallback(async (kind: "checkout" | "portal" | "reconcile", body?: unknown) => {
    try {
      const payload = await command.mutateAsync({ kind, body });
      const destination = payload.checkoutUrl ?? payload.portalUrl;
      if (destination) window.location.assign(destination);
    } catch {}
  }, [command]);

  // A return from Checkout is confirmed by asking the Hub to reconcile that
  // session with Stripe; the webhook may not have arrived yet.
  useEffect(() => {
    if (!spaceId || !billing?.canManage) return;
    if (returned.spaceNotice !== "success" && !returned.spaceSessionId) return;
    const key = `${spaceId}:${returned.spaceSessionId || "return"}`;
    if (reconciled.current === key) return;
    reconciled.current = key;
    returned.clear();
    if (returned.spaceSessionId) void run("reconcile", { checkoutSessionId: returned.spaceSessionId });
    else if (billing.plan !== "pro") void run("reconcile");
  }, [billing?.canManage, billing?.plan, returned, run, spaceId]);

  if (!space) return <p className="text-sm text-muted-foreground">Open a Space to see its plan.</p>;

  const mark = spacePlanMark(billing);
  const subscription = billing?.subscription ?? null;
  const periodEnd = subscription?.currentPeriodEnd ? formatPlanDate(subscription.currentPeriodEnd) : null;
  const price = PRO_SEAT_PRICE_USD[interval];
  return (
    <div className="app-settings-section min-w-0 space-y-4" data-testid="space-billing">
      {returned.spaceNotice === "success" && (
        <p className={noticeClass("settled")}>
          {billing?.plan === "pro" ? `Payment received. ${space.name} is on Pro.` : "Payment received. Confirming the checkout with Stripe…"}
        </p>
      )}
      {returned.spaceNotice === "cancelled" && <p className={noticeClass("settled")}>Checkout was cancelled; nothing was changed.</p>}
      {!billing ? (
        !error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading plan…</div>
      ) : billing.plan === "pro" ? (
        <>
          <PlanCard
            plan="pro"
            name="Pro"
            aside={periodEnd ? `${subscription?.cancelAtPeriodEnd ? "Ends" : "Renews"} ${periodEnd}` : undefined}
            title={space.name}
            state={mark && mark.state !== "active" ? { label: mark.state === "blocked" ? "Blocked" : capitalized(subscription?.status ?? "Ending"), title: mark.title, alert: mark.state === "blocked" } : null}
          >
            <SeatPips used={billing.seats.used} limit={billing.seats.limit} />
            <PlanFeatures features={PRO_PLAN_FEATURES} />
          </PlanCard>
          <BillingWarnings billing={billing} spaceName={space.name} />
          {!billing.canManage ? (
            <p className="text-sm text-muted-foreground">Only the Space owner can change its plan.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button type="button" className={actionClass({ variant: "secondary", size: "md" })} disabled={busy !== null} onClick={() => void run("portal")}>
                {busy === "portal" ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                Manage subscription
              </button>
              <button type="button" className={actionClass({ variant: "secondary", size: "md" })} disabled={busy !== null} onClick={() => void run("reconcile")}>
                <RefreshCw className={cn("size-4", busy === "reconcile" && "animate-spin")} />
                Refresh from Stripe
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <PlanCard plan="free" name="Free" title={space.name}>
            <PlanMeter label="Messages" used={billing.freeUsage.acceptedMessages} limit={billing.freeUsage.limit} />
            <SeatPips used={billing.seats.used} limit={billing.seats.limit} />
          </PlanCard>
          <BillingWarnings billing={billing} spaceName={space.name} />
          <PlanCard
            plan="pro"
            name="Pro"
            aside={interval === "year" ? `$${price} a seat, yearly` : `$${price} a seat, monthly`}
            title="Unmetered messages and room for your whole team."
            stub={billing.canManage ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <SegmentedTabs
                    label="Billing interval"
                    value={interval}
                    onChange={setInterval}
                    items={[{ key: "month", label: "Monthly" }, { key: "year", label: "Yearly, save 20%" }]}
                  />
                  <label className="flex w-full items-center justify-between gap-3 text-sm font-medium sm:w-auto">
                    People
                    <input
                      className="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-right tabular-nums"
                      type="number"
                      min={Math.max(1, billing.seats.used)}
                      max={99}
                      value={seats}
                      onChange={(event) => setSeats(Math.min(99, Math.max(Math.max(1, billing.seats.used), Number(event.target.value) || 1)))}
                    />
                  </label>
                </div>
                <button type="button" className={actionClass({ variant: "primary", size: "lg" }, "w-full")} disabled={busy !== null}
                  onClick={() => void run("checkout", { interval, seatQuantity: seats })}>
                  {busy === "checkout" && <Loader2 className="size-4 animate-spin" />}
                  Upgrade to Pro for ${price * seats} a {interval === "year" ? "year" : "month"}
                </button>
                <p className="text-xs text-muted-foreground">
                  Renews until you cancel in the billing portal; cancelling takes effect at the end of the paid period.
                  Tax is added at checkout. See <Link className="underline underline-offset-4" href="/terms#billing">Terms §12</Link>.
                </p>
              </div>
            ) : <p className="text-sm">Ask the Space owner to upgrade.</p>}
          >
            <PlanFeatures features={PRO_PLAN_FEATURES} />
          </PlanCard>
        </>
      )}
      <SectionError error={error} />
    </div>
  );
}

function BillingWarnings({ billing, spaceName }: { billing: SpaceBilling; spaceName: string }) {
  return (
    <>
      {billing.subscription?.access === "read_only" && (
        <p className={noticeClass("alert")}>{spaceName} is read-only until the past-due payment is resolved.</p>
      )}
      {billing.seatAdjustmentRequired && (
        <p className={noticeClass("alert")}>
          More members than purchased seats. Remove members or add seats in the billing portal before sending new messages.
        </p>
      )}
    </>
  );
}


/*
 * A paid plan is a pane of liquid glass set into the app's wood plank, its
 * name and marks in brass and its text in black; Free is the paper it sits
 * on, outlined in ink. The difference is the material, not a louder colour. An offer for Pro is the same
 * plank with a paper stub below it, where the choices and the button live.
 */
function PlanCard({ plan, name, aside, title, state, stub, children }: {
  plan: "pro" | "free";
  name: string;
  aside?: string;
  title: string;
  state?: { label: string; title: string; alert: boolean } | null;
  stub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const face = (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="app-plan-name">{name}</h3>
        <span className="app-plan-aside flex items-center gap-2">
          {state && <span className={statusChipClass(state.alert ? "alert" : "secondary")} title={state.title}>{state.label}</span>}
          {aside}
        </span>
      </div>
      <p className="app-plan-title mt-1 [overflow-wrap:anywhere]">{title}</p>
      {children && <div className="app-plan-body mt-5 space-y-5">{children}</div>}
    </>
  );
  return (
    plan === "pro" ? (
      <WoodPanel as="section" className="app-plan-card" data-plan="pro">
        <LiquidGlassCard className="app-plan-card-face">{face}</LiquidGlassCard>
        {stub && <div className="app-plan-stub">{stub}</div>}
      </WoodPanel>
    ) : (
      <section className="app-plan-card" data-plan="free">
        <div className="app-plan-card-face">{face}</div>
        {stub && <div className="app-plan-stub">{stub}</div>}
      </section>
    )
  );
}

/** Seats are people, so each one is a mark of its own while there are few enough to count. */
function SeatPips({ used, limit }: { used: number; limit: number }) {
  if (limit > 24) return <PlanMeter label="Seats" used={used} limit={limit} />;
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="app-plan-meter-label">{used} of {limit} seats used</span>
      <span className="flex gap-1" role="meter" aria-label="Seats" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        {Array.from({ length: limit }, (_, index) => (
          <span key={index} className="app-plan-pip" data-used={index < used ? "true" : undefined} />
        ))}
      </span>
    </div>
  );
}

function PlanMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="app-plan-meter" data-full={ratio >= 1 ? "true" : undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="app-plan-meter-label">{label}</span>
        <span className="app-plan-meter-label tabular-nums">{used.toLocaleString()} of {limit.toLocaleString()}</span>
      </div>
      <div className="app-plan-meter-track mt-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <span className="app-plan-meter-fill" style={{ width: `${Math.max(ratio * 100, used > 0 ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}

function PlanFeatures({ features }: { features: readonly string[] }) {
  return (
    <ul className="app-plan-features grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {features.map((feature) => (
        <li key={feature} className="flex items-start gap-2">
          <Check className="app-plan-check mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {feature}
        </li>
      ))}
    </ul>
  );
}

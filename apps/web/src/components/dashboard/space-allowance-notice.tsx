"use client";

import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { CreditCard } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { statusChipClass } from "@/components/ui/status-tone";
import { AskCard } from "./ask-card";
import { spaceAllowanceNotice } from "./space-plan-mark";
import { useSpaceBilling } from "./settings-billing";

/* Codes a write is refused with once its Space's plan cannot pay for it. */
const PLAN_REFUSALS = new Set(["payment_required", "credits_exhausted", "billing_grace_read_only"]);

/* Hiding the card is remembered per Space for the state it hid, the way the
   approvals dock collapses the requests it showed: a new state (low → used up)
   or a refused send brings it back. */
const HIDDEN_KEY_PREFIX = "xmatrix.allowance-hidden:";
const HIDDEN_EVENT = "xmatrix:allowance-hidden";

function hiddenStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function setHiddenKind(spaceId: string, kind: string | null) {
  const store = hiddenStore();
  try {
    if (kind) store?.setItem(HIDDEN_KEY_PREFIX + spaceId, kind);
    else store?.removeItem(HIDDEN_KEY_PREFIX + spaceId);
  } catch { /* A blocked store only means the card shows again. */ }
  window.dispatchEvent(new Event(HIDDEN_EVENT));
}

function subscribeHidden(onChange: () => void) {
  window.addEventListener(HIDDEN_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(HIDDEN_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function useHiddenKind(spaceId: string): string | null {
  return useSyncExternalStore(subscribeHidden, () => {
    try { return hiddenStore()?.getItem(HIDDEN_KEY_PREFIX + spaceId) ?? null; } catch { return null; }
  }, () => null);
}

/** A send refused for its plan re-reads the Space's billing, so the notice
 * above the composer says why at once instead of on its next poll. */
export function refreshSpaceAllowanceAfterRefusal(queryClient: QueryClient, userId: string | undefined,
  spaceId: string | undefined, error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (!userId || !spaceId || typeof code !== "string" || !PLAN_REFUSALS.has(code)) return;
  setHiddenKind(spaceId, null);
  void queryClient.invalidateQueries({ queryKey: xmatrixQueryKeys.domain({ userId }, "billing", [spaceId]) });
}

/** The Space's billing, read again as its count moves: every message anyone
 * or any Agent writes moves it, so more often once a notice is up. */
export function useSpaceAllowance(userId: string | undefined, spaceId: string | null | undefined) {
  const billing = useSpaceBilling(userId ?? "", userId && spaceId ? spaceId : null, {
    refetchInterval: (data) => {
      const notice = spaceAllowanceNotice(data);
      return notice ? 30_000 : data?.plan === "free" ? 120_000 : 300_000;
    },
  });
  return { notice: spaceAllowanceNotice(billing.data), canManage: billing.data?.canManage !== false };
}

/* The Space is close to, or past, the point where its writes are refused
   (spaceAllowanceNotice). It asks the reader to act as an approval does, so it
   is the same slip of brass paper in the same place: an ask card above the
   composer, where Pending approvals dock. Nothing is shown while the billing is
   unread or the deployment has no plans. `docked` lays it in the dock's block. */
export function SpaceAllowanceNotice({ spaceId, token, userId, onOpenBilling, docked = false }: {
  spaceId: string; token: string | null; userId: string;
  /** Opens Settings › Billing in the app; without it the notice links to /billing. */
  onOpenBilling?: () => void;
  docked?: boolean;
}) {
  const { notice, canManage } = useSpaceAllowance(userId, spaceId);
  const copy = useOnboardingCopy(spaceId, token, userId).allowance;
  const hiddenKind = useHiddenKind(spaceId);
  if (!notice) return null;
  const blocked = notice.kind !== "free-low";
  const question = notice.kind === "free-low" ? copy.freeLowTitle(notice.remaining)
    : notice.kind === "free-used" ? copy.freeUsedTitle : copy.creditsPausedTitle;
  const detail = notice.kind === "free-low" ? copy.freeLow(notice.remaining, notice.limit)
    : notice.kind === "free-used" ? copy.freeUsed(notice.limit) : copy.creditsPaused(notice.resetsOn);
  const action = notice.kind === "credits-paused" ? copy.buyCredits : copy.upgrade;
  const actionClassName = actionClass({ variant: "primary", size: "sm" });
  const status = { tone: blocked ? "alert" : "attention", label: blocked ? copy.stopped : copy.runningLow } as const;
  const hidden = hiddenKind === notice.kind;
  const card = hidden ? (
    // Collapsed to one line that still says what stands, as the approvals dock does.
    <div className="flex min-w-0 items-center gap-2 text-[13px]">
      <CreditCard className="app-ask-card-kicker size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-semibold">{question}</span>
      <span className={statusChipClass(status.tone, "shrink-0")}>{status.label}</span>
      <button type="button" className={actionClass({ variant: "secondary", size: "sm" })}
        aria-expanded={false} onClick={() => setHiddenKind(spaceId, null)}>{copy.show}</button>
    </div>
  ) : (
    <AskCard who="xMatrix" kind={copy.kind} icon={<CreditCard className="size-3.5" />} open
      question={question} detail={detail} status={status}>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!canManage
          ? <span className="text-[13px] text-muted-foreground">
            {notice.kind === "credits-paused" ? copy.askOwnerCredits : copy.askOwnerUpgrade}</span>
          : onOpenBilling
            ? <button type="button" className={actionClassName} onClick={onOpenBilling}>{action}</button>
            : <a className={actionClassName} href={`/billing?space=${encodeURIComponent(spaceId)}`}>{action}</a>}
        <button type="button" className={actionClass({ variant: "secondary", size: "sm" })}
          aria-expanded onClick={() => setHiddenKind(spaceId, notice.kind)}>{copy.hide}</button>
      </div>
    </AskCard>
  );
  const state = { role: blocked ? "alert" : "status", "data-testid": "space-allowance-notice", "data-allowance": notice.kind };
  // A section, as the approvals dock is: the dock's own rules for a `div` child are the Agent strip's.
  return docked
    ? <section {...state} aria-label={copy.kind} className="app-channel-approvals pointer-events-auto mb-2 px-3 py-2.5">{card}</section>
    : <div {...state} className="px-5 pb-2">{card}</div>;
}

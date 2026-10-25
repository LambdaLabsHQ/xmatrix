"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { CreditCard } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { AskCard } from "./ask-card";
import { spaceAllowanceNotice } from "./space-plan-mark";
import { useSpaceBilling } from "./settings-billing";

/* Codes a write is refused with once its Space's plan cannot pay for it. */
const PLAN_REFUSALS = new Set(["payment_required", "credits_exhausted", "billing_grace_read_only"]);

/** A send refused for its plan re-reads the Space's billing, so the notice
 * above the composer says why at once instead of on its next poll. */
export function refreshSpaceAllowanceAfterRefusal(queryClient: QueryClient, userId: string | undefined,
  spaceId: string | undefined, error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (!userId || !spaceId || typeof code !== "string" || !PLAN_REFUSALS.has(code)) return;
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
  if (!notice) return null;
  const blocked = notice.kind !== "free-low";
  const question = notice.kind === "free-low" ? copy.freeLowTitle(notice.remaining)
    : notice.kind === "free-used" ? copy.freeUsedTitle : copy.creditsPausedTitle;
  const detail = notice.kind === "free-low" ? copy.freeLow(notice.remaining, notice.limit)
    : notice.kind === "free-used" ? copy.freeUsed(notice.limit) : copy.creditsPaused(notice.resetsOn);
  const action = notice.kind === "credits-paused" ? copy.buyCredits : copy.upgrade;
  const actionClassName = actionClass({ variant: "primary", size: "sm" });
  const card = (
    <AskCard who="xMatrix" kind={copy.kind} icon={<CreditCard className="size-3.5" />} open
      question={question} detail={detail}
      status={{ tone: blocked ? "alert" : "attention", label: blocked ? copy.stopped : copy.runningLow }}>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!canManage
          ? <span className="text-[13px] text-muted-foreground">
            {notice.kind === "credits-paused" ? copy.askOwnerCredits : copy.askOwnerUpgrade}</span>
          : onOpenBilling
            ? <button type="button" className={actionClassName} onClick={onOpenBilling}>{action}</button>
            : <a className={actionClassName} href={`/billing?space=${encodeURIComponent(spaceId)}`}>{action}</a>}
      </div>
    </AskCard>
  );
  const state = { role: blocked ? "alert" : "status", "data-testid": "space-allowance-notice", "data-allowance": notice.kind };
  // A section, as the approvals dock is: the dock's own rules for a `div` child are the Agent strip's.
  return docked
    ? <section {...state} aria-label={copy.kind} className="app-channel-approvals pointer-events-auto mb-2 px-3 py-2.5">{card}</section>
    : <div {...state} className="px-5 pb-2">{card}</div>;
}

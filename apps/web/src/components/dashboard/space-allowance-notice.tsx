"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { MESSAGE_COLUMN_CLASS_NAME, MESSAGE_ROW_CLASS_NAME } from "./row-frames";
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

/* The last row of the conversation, on the same paper as its messages: the
   Space is close to, or past, the point where its writes are refused
   (spaceAllowanceNotice). The "!" sits in the avatar column and takes the
   unsent row's ink, so a refusal reads the same wherever it is said. The count
   moves with every message anyone or any Agent writes, so the read is repeated,
   more often once it is low; nothing is shown while it is unread or the
   deployment has no plans. */
export function SpaceAllowanceNotice({ spaceId, token, userId, onOpenBilling }: {
  spaceId: string; token: string | null; userId: string;
  /** Opens Settings › Billing in the app; without it the notice links to /billing. */
  onOpenBilling?: () => void;
}) {
  const billing = useSpaceBilling(userId, spaceId, {
    refetchInterval: (data) => {
      const notice = spaceAllowanceNotice(data);
      return notice ? 30_000 : data?.plan === "free" ? 120_000 : 300_000;
    },
  });
  const copy = useOnboardingCopy(spaceId, token, userId).allowance;
  const notice = spaceAllowanceNotice(billing.data);
  if (!notice) return null;
  const blocked = notice.kind !== "free-low";
  const text = notice.kind === "free-low" ? copy.freeLow(notice.remaining, notice.limit)
    : notice.kind === "free-used" ? copy.freeUsed(notice.limit) : copy.creditsPaused(notice.resetsOn);
  const action = notice.kind === "credits-paused" ? copy.buyCredits : copy.upgrade;
  const actionClass = "inline-flex min-h-11 shrink-0 items-center px-4 text-[13px] font-semibold md:min-h-8";
  return (
    <div role={blocked ? "alert" : "status"} data-testid="space-allowance-notice" data-allowance={notice.kind}
      className={cn(MESSAGE_ROW_CLASS_NAME, "app-allowance-notice py-3", blocked && "app-allowance-notice-blocked")}>
      <span className="flex w-(--app-message-avatar-size) shrink-0 justify-center pt-1" aria-hidden="true">
        <span className="app-message-unsent-badge">!</span>
      </span>
      <div className={cn(MESSAGE_COLUMN_CLASS_NAME, "flex flex-wrap items-center gap-x-3 gap-y-2")}>
        <p className={cn("min-w-0 flex-1 text-[15px] leading-[1.75] [overflow-wrap:anywhere]",
          blocked && "app-message-unsent-ink font-semibold")}>{text}</p>
        {billing.data?.canManage === false
          ? <span className="text-[13px] text-muted-foreground">
            {notice.kind === "credits-paused" ? copy.askOwnerCredits : copy.askOwnerUpgrade}</span>
          : onOpenBilling
            ? <LiquidGlassPill as="button" type="button" className={actionClass} onClick={onOpenBilling}>{action}</LiquidGlassPill>
            : <LiquidGlassPill as="a" className={actionClass} href={`/billing?space=${encodeURIComponent(spaceId)}`}>{action}</LiquidGlassPill>}
      </div>
    </div>
  );
}

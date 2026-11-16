"use client";

import { useQuery } from "@tanstack/react-query";

import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { spacePlansAbsent, type SpacePlanBilling } from "./space-plan-mark";

// A Space's plan as read for its allowance notice, kept apart from the Billing
// section (settings-billing.tsx), which loads only with Settings.

export const SPACE_BILLING_SECTION = "billing";

export type SpaceBilling = SpacePlanBilling & {
  plan: "free" | "pro";
  canManage: boolean;
  seats: { used: number; limit: number };
  freeUsage: { acceptedMessages: number; limit: number; remaining: number };
  subscription: {
    billingProvider?: "stripe" | "apple" | "google";
    status: string;
    seatQuantity: number;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil?: string;
    access?: "full" | "read_only";
  } | null;
  seatAdjustmentRequired?: boolean;
  /** A Pro Space's Agent credits this month (docs/design/agent-credits.md). */
  credits?: SpaceCredits;
  /** Who used the allowance: this month's credits on Pro, every write on Free. */
  usage?: SpaceUsage;
};

export type SpaceUsageItem = {
  kind: "agent" | "app" | "user" | "x";
  /** The person, or the Agent's owner; empty for an app. */
  ownerUserId: string;
  ownerName: string;
  /** An Agent's or app's name; empty for a person. */
  name: string;
  messages: number;
  pageRevisions: number;
  units: number;
};

export type SpaceUsage = {
  meter: "credit" | "free";
  /** The deployment's own Space: credits counted, never charged. */
  waived: boolean;
  since: string | null;
  items: SpaceUsageItem[];
};

export type SpaceCredits = {
  periodStart: string;
  resetsOn: string;
  included: number;
  includedUsed: number;
  packBalance: number;
  packUsed: number;
  grace: number;
  graceUsed: number;
  paused: boolean;
  packCredits: number;
};

export function spaceBillingKey(userId: string, spaceId: string) {
  return xmatrixQueryKeys.domain({ userId }, "billing", [spaceId]);
}

export function useSpaceBilling(userId: string, spaceId: string | null, options?: {
  /** How soon to read again, from what was last read. */
  refetchInterval?: (billing: SpaceBilling | undefined) => number | false;
}) {
  const refetchInterval = options?.refetchInterval;
  return useQuery({
    queryKey: spaceBillingKey(userId, spaceId ?? ""),
    queryFn: ({ signal }) => xmatrixApiRequest<{ billing: SpaceBilling }>({
      url: `/api/xmatrix/spaces/${encodeURIComponent(spaceId!)}/billing`, signal,
    }).then((payload) => payload.billing),
    enabled: Boolean(spaceId),
    retry: (failures, error) => !spacePlansAbsent(error) && failures < 3,
    refetchInterval: refetchInterval
      ? (query) => spacePlansAbsent(query.state.error) ? false : refetchInterval(query.state.data)
      : undefined,
  });
}

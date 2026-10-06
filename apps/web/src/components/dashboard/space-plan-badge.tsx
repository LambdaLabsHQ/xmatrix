"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";
import { spacePlanMark, spacePlansAbsent, type SpacePlanBilling, type SpacePlanMark } from "./space-plan-mark";
import {
  postSpacePlanRefresh,
  spacePlanMarkSignature,
  spacePlanNoticeNeedsFetch,
  spacePlanRefreshToPublish,
  subscribeSpacePlanRefresh,
} from "./space-plan-refresh";
import { COUNT_CHIP_MATERIAL_CLASS } from "./workspace-shell-constants";

/* The plan changes at Stripe's pace, not the shell's, and the read costs a
   billing-authority round trip, so a tab does not poll. The shell stays
   mounted, and focus refetch is off for every other query, so this one
   rereads whenever its tab is shown. A tab that sees the mark change tells
   the other open tabs, and they reread at once. */
const SPACE_PLAN_STALE_MS = 5 * 60 * 1_000;

/** Reads the billing summary for one Space and reduces it to its mark.
 *
 * The key is the billing page's own key, so opening Billing and returning to
 * the workspace shares a single read, and a checkout that writes the fresher
 * summary into the cache updates the badge with it — and the other tabs. */
export function useSpacePlanMark(input: {
  userId: string | null | undefined;
  spaceId: string | null;
}): SpacePlanMark | null {
  const userId = input.userId || "anonymous";
  const spaceId = input.spaceId || "";
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => xmatrixQueryKeys.domain({ userId }, "billing", [spaceId]),
    [userId, spaceId],
  );
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => xmatrixApiRequest<{ billing: SpacePlanBilling }>({
      url: `/api/xmatrix/spaces/${encodeURIComponent(spaceId)}/billing`,
      signal,
    }).then((payload) => payload.billing),
    enabled: Boolean(spaceId),
    staleTime: SPACE_PLAN_STALE_MS,
    refetchOnWindowFocus: "always",
    retry: (failures, error) => !spacePlansAbsent(error) && failures < 3,
  });
  const seen = useRef<{ spaceId: string; signature: string } | undefined>(undefined);

  useEffect(() => {
    if (!spaceId) return;
    const next = spacePlanMarkSignature(query.data);
    const sameSpace = seen.current?.spaceId === spaceId;
    const publish = sameSpace ? spacePlanRefreshToPublish(seen.current?.signature, next) : null;
    if (next !== null) seen.current = { spaceId, signature: next };
    else if (!sameSpace) seen.current = undefined;
    if (!publish) return;
    postSpacePlanRefresh({ userId, spaceId, signature: publish });
  }, [query.data, spaceId, userId]);

  useEffect(() => {
    if (!spaceId) return;
    return subscribeSpacePlanRefresh((notice) => {
      const current = queryClient.getQueryData<SpacePlanBilling>(queryKey);
      if (!spacePlanNoticeNeedsFetch(notice, {
        userId,
        spaceId,
        signature: spacePlanMarkSignature(current),
      })) return;
      void queryClient.invalidateQueries({ queryKey });
    });
  }, [queryClient, queryKey, spaceId, userId]);

  return spacePlanMark(query.data);
}

/** The plan mark beside the Space name.
 *
 * It renders nothing at all until the plan is known — a mark that flickered in
 * on every cold start would read as a state change of the Space, and guessing
 * Free while the read is in flight would state an entitlement it has not read.
 *
 * It wears the shared chip glass every other chip in the app wears and
 * contributes only its ink (`.app-space-plan-mark` in themes/materials.css),
 * so a plan is a colour of the existing material rather than a second chip
 * material: brass for Pro, plain ink for Free, and the theme's alert ink when
 * the Space cannot send at all. */
export function SpacePlanBadge({ userId, spaceId, className }: {
  userId: string | null | undefined;
  spaceId: string | null;
  className?: string;
}) {
  const mark = useSpacePlanMark({ userId, spaceId });
  if (!mark) return null;
  return (
    <span
      className={cn(COUNT_CHIP_MATERIAL_CLASS, "app-space-plan-mark", className)}
      data-plan={mark.plan}
      data-state={mark.state}
      title={mark.title}
    >
      {mark.label}
    </span>
  );
}

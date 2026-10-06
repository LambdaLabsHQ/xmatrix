"use client";

import { Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { spaceAppPath } from "@/components/dashboard/channel-links";
import { SPACE_BILLING_SECTION } from "@/components/dashboard/settings-billing";
import type { SerializedSpace } from "@xmatrix/protocol";

/*
 * Billing lives in the app, under Settings. This address stays because Stripe
 * Checkout and the Stripe portal return to it, and older links name it:
 * it forwards to the Space's Billing
 * section with the return parameters intact.
 */
export default function BillingPage() {
  return <Suspense fallback={<main className="site-page min-h-screen" />}><BillingRedirect /></Suspense>;
}

function BillingRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading } = useAuth();
  const spacesQuery = useQuery({
    queryKey: xmatrixQueryKeys.spaces({ userId: user?.id ?? "anonymous" }),
    queryFn: ({ signal }) => xmatrixApiRequest<{ spaces: SerializedSpace[] }>({
      url: "/api/xmatrix/spaces", signal,
    }).then((payload) => payload.spaces),
    enabled: Boolean(user),
  });

  useEffect(() => {
    if (loading) return;
    if (!user) {
      const query = searchParams.toString();
      router.replace(`/login?next=${encodeURIComponent(`/billing${query ? `?${query}` : ""}`)}`);
      return;
    }
    // Without the Space list the app opens its own Space, and Settings in it.
    const spaces = spacesQuery.data ?? (spacesQuery.isError ? [] : null);
    if (!spaces) return;
    const next = new URLSearchParams(searchParams.toString());
    const requested = next.get("space");
    next.delete("space");
    next.set("item", SPACE_BILLING_SECTION);
    const space = spaces.find((item) => item.id === requested) ?? spaces[0];
    if (space) {
      router.replace(`${spaceAppPath(space.id, spaces)}/settings?${next.toString()}`);
    } else {
      next.set("view", "settings");
      router.replace(`/app?${next.toString()}`);
    }
  }, [loading, router, searchParams, spacesQuery.data, spacesQuery.isError, user]);

  return <main className="site-page min-h-screen" />;
}

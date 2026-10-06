"use client";

/**
 * Reads the Hub-reported operator capability for the signed-in session.
 *
 * This decides what the shell offers, never what it may read: the Hub
 * re-checks the platform-admin allowlist on every admin route, so a client
 * that forces the flag on only reaches a 403.
 */

import { useQuery } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type AuthCapabilities, type MeResponse } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

export function useAuthCapability(capability: keyof AuthCapabilities, token?: string): boolean {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: user?.id ?? "anonymous" }, "auth-capabilities",
    ),
    queryFn: ({ signal }) => xmatrixApiRequest<Partial<MeResponse>>({
      url: WEB_PROXY_ROUTES.me, token, signal,
    }),
    enabled: Boolean(token && user?.id),
    staleTime: 60_000,
  });
  // Capability probes fail closed; the Hub remains the authorization boundary.
  return query.data?.capabilities?.[capability] === true;
}

export function usePlatformAdminCapability(token?: string): boolean {
  return useAuthCapability("platformAdmin", token);
}

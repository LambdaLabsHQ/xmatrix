"use client";

import { useQuery } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type AgentCapabilitySummary, type AgentRegistrationSummary } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { AGENT_USAGE_REFRESH_MS } from "./agent-quota-usage";

/** `live`: the reader is watching (the Agents page), so the catalog is read
 * again every few seconds and the Hub is asked to read quota again. */
export function useAgentRegistrationCatalog(spaceId: string, token: string, enabled: boolean,
  options: { live?: boolean } = {}) {
  const { user } = useAuth();
  const live = options.live === true;
  return useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "agent-registration-catalog", [spaceId]),
    enabled: enabled && Boolean(user?.id), retry: false, staleTime: 10_000,
    ...(live ? { refetchInterval: AGENT_USAGE_REFRESH_MS } : {}),
    queryFn: async ({ signal }) => {
      const result = await xmatrixApiRequest<{ capabilities: AgentCapabilitySummary[]; registrations: AgentRegistrationSummary[] }>({
        url: `${WEB_PROXY_ROUTES.space_agent_registrations(spaceId)}${live ? "?quota=refresh" : ""}`, token,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!Array.isArray(result.capabilities) || !Array.isArray(result.registrations)) throw new Error("Invalid registration catalog");
      return result;
    },
  });
}

"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type AgentCapabilitySummary, type AgentRegistrationSummary } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { AGENT_USAGE_REFRESH_MS } from "./agent-quota-usage";

/** `live`: the reader is watching (the Agents page). The catalog is read again
 * every few seconds, and a reading pushed over the socket is shown at once.
 * The Hub is asked to read provider quota only when the page opens or comes
 * back into view: a reading nobody looks at is not worth a request, and one
 * already current is not read again (the Hub reads each daemon at most once a
 * minute). */
export function useAgentRegistrationCatalog(spaceId: string, token: string, enabled: boolean,
  options: { live?: boolean } = {}) {
  const { user } = useAuth();
  const live = options.live === true;
  const readQuota = useRef(live);
  const query = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "agent-registration-catalog", [spaceId]),
    enabled: enabled && Boolean(user?.id), retry: false, staleTime: 10_000,
    ...(live ? { refetchInterval: AGENT_USAGE_REFRESH_MS } : {}),
    queryFn: async ({ signal }) => {
      const refreshQuota = live && readQuota.current;
      readQuota.current = false;
      const result = await xmatrixApiRequest<{ capabilities: AgentCapabilitySummary[]; registrations: AgentRegistrationSummary[] }>({
        url: `${WEB_PROXY_ROUTES.space_agent_registrations(spaceId)}${refreshQuota ? "?quota=refresh" : ""}`, token,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!Array.isArray(result.capabilities) || !Array.isArray(result.registrations)) throw new Error("Invalid registration catalog");
      return result;
    },
  });
  const { refetch } = query;
  useEffect(() => {
    if (!live) return;
    // Coming back into view is the moment the reader looks again.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      readQuota.current = true;
      void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [live, refetch]);
  return query;
}

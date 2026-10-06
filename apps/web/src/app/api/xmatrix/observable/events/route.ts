import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", (_params, url) => {
  const params = pickSearchParams(url.searchParams, ["limit", "since"]);
  for (const key of ["eventType", "channelId", "agentId"]) {
    for (const value of url.searchParams.getAll(key)) {
      params.append(key, value);
    }
  }
  return withSearchParams(HUB_ROUTES.observable_events, params);
});

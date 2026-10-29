import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", (_params, url) => {
  const spaceId = url.searchParams.get("spaceId");
  return spaceId ? `${HUB_ROUTES.connector_oauth_providers}?spaceId=${encodeURIComponent(spaceId)}` : HUB_ROUTES.connector_oauth_providers;
});

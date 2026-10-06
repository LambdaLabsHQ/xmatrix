import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler, hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom(
  "GET",
  (_params, url) => {
    const params = pickSearchParams(url.searchParams, ["spaceId"]);
    const catalogSyncToken = url.searchParams.get("catalogSyncToken");
    if (catalogSyncToken && catalogSyncToken.length <= 8_192) {
      params.set("catalogSyncToken", catalogSyncToken);
    }
    return withSearchParams(HUB_ROUTES.channels, params);
  },
  { responseHeaders: ["content-type", "cache-control", "retry-after"] },
);

export const POST = hubRouteHandler("POST", HUB_ROUTES.channels);

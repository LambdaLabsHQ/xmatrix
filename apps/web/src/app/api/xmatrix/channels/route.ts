import { CHANNEL_CREATE_KEY_HEADER, HUB_ROUTES } from "@xmatrix/protocol";
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

// The browser names the create, so it knows the Channel's id before the Hub answers.
export const POST = hubRouteHandler("POST", HUB_ROUTES.channels, [], { requestHeaders: [CHANNEL_CREATE_KEY_HEADER] });

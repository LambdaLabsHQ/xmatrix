import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", (_params, url) =>
  withSearchParams(HUB_ROUTES.message_search, pickSearchParams(url.searchParams, ["spaceId", "query", "cursor", "channelId", "from"])));

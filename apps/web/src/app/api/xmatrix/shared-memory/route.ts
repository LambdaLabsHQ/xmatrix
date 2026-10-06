import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler, hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", (_params, url) =>
  withSearchParams(HUB_ROUTES.shared_memory, pickSearchParams(url.searchParams, ["key", "prefix", "limit"])));

export const POST = hubRouteHandler("POST", HUB_ROUTES.shared_memory);

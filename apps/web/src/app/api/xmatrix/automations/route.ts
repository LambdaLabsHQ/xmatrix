import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler, hubRouteHandlerFrom, withSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom("GET", (_params, url) =>
  withSearchParams(HUB_ROUTES.automations, url.searchParams));

export const POST = hubRouteHandler("POST", HUB_ROUTES.automations);

import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler, hubRouteHandlerFrom, pickSearchParams, withSearchParams } from "@/lib/xmatrix-proxy";

/** The fallback where the page cannot ask the Hub straight (lib/query/hub-read.ts). */
export const GET = hubRouteHandlerFrom("GET", (_params, url) =>
  withSearchParams(HUB_ROUTES.me_diagnostics, pickSearchParams(url.searchParams, ["build"])));
export const PUT = hubRouteHandler("PUT", HUB_ROUTES.me_diagnostics);

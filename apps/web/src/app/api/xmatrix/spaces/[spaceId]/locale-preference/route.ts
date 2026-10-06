import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.space_locale_preference, ["spaceId"]);
export const PATCH = hubRouteHandler("PATCH", HUB_ROUTES.space_locale_preference, ["spaceId"]);

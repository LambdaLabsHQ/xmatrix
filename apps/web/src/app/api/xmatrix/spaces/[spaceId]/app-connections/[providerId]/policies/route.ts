import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.space_app_connection_policies, ["spaceId", "providerId"]);
export const PUT = hubRouteHandler("PUT", HUB_ROUTES.space_app_connection_policies, ["spaceId", "providerId"]);

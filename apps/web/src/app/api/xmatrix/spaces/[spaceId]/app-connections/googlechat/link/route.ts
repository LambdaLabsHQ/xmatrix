import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";
export const GET = hubRouteHandler("GET", HUB_ROUTES.space_app_connection_googlechat_link, ["spaceId"], { body: false });
export const POST = hubRouteHandler("POST", HUB_ROUTES.space_app_connection_googlechat_link, ["spaceId"]);

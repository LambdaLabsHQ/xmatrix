import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";
export const GET = hubRouteHandler("GET", HUB_ROUTES.space_app_connection_telegram_link, ["spaceId"], { body: false });
export const POST = hubRouteHandler("POST", HUB_ROUTES.space_app_connection_telegram_link, ["spaceId"]);
export const DELETE = hubRouteHandler("DELETE", HUB_ROUTES.space_app_connection_telegram_link, ["spaceId"]);

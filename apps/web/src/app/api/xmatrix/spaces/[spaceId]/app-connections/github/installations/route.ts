import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.space_app_connection_github_installations, ["spaceId"]);
export const POST = hubRouteHandler("POST", HUB_ROUTES.space_app_connection_github_installations, ["spaceId"]);

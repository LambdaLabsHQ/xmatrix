import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const PATCH = hubRouteHandler("PATCH", HUB_ROUTES.channel, ["channelId"]);
export const DELETE = hubRouteHandler("DELETE", HUB_ROUTES.channel, ["channelId"]);

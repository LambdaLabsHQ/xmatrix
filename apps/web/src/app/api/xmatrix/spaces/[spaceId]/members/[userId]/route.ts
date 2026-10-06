import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const DELETE = hubRouteHandler("DELETE", HUB_ROUTES.space_member, ["spaceId", "userId"]);

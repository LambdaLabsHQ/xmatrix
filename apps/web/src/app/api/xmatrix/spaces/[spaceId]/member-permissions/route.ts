import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const PATCH = hubRouteHandler("PATCH", HUB_ROUTES.space_member_permissions, ["spaceId"]);

import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const POST = hubRouteHandler("POST", HUB_ROUTES.cross_space_read_grant_decision, ["spaceId", "grantId"]);

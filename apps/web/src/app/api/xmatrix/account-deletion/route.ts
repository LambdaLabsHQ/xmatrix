import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.account_deletion);
export const POST = hubRouteHandler("POST", HUB_ROUTES.account_deletion);

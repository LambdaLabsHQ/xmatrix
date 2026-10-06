import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.spaces);
export const POST = hubRouteHandler("POST", HUB_ROUTES.spaces);

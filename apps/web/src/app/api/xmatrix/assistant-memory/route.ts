import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.assistant_memory);
export const POST = hubRouteHandler("POST", HUB_ROUTES.assistant_memory);

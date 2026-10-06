import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const POST = hubRouteHandler("POST", HUB_ROUTES.secret_request_status);

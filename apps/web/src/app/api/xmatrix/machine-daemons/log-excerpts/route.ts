import { hubRouteHandler } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export const POST = hubRouteHandler("POST", HUB_ROUTES.machine_log_excerpts);

import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const PUT = hubRouteHandler("PUT", HUB_ROUTES.machine_auto_assign, ["machineId"]);

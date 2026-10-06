import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";
export const POST = hubRouteHandler("POST", HUB_ROUTES.connector_wecom_install_prepare);

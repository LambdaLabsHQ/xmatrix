import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.channel_message_connector_result, ["channelId", "messageId"]);

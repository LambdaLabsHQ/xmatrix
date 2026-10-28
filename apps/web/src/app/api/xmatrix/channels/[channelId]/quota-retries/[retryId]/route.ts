import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandler("GET", HUB_ROUTES.channel_quota_retry, ["channelId", "retryId"]);
export const POST = hubRouteHandler("POST", HUB_ROUTES.channel_quota_retry, ["channelId", "retryId"]);

import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler, hubRouteHandlerFrom, withSearchParams } from "@/lib/xmatrix-proxy";

export const POST = hubRouteHandler("POST", HUB_ROUTES.channel_annotations, ["channelId"]);

export const GET = hubRouteHandlerFrom("GET", ({ channelId }: { channelId: string }, url) =>
  withSearchParams(HUB_ROUTES.channel_annotations(channelId), url.searchParams));

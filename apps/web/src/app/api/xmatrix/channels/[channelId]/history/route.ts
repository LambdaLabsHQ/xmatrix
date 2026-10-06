import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom, withSearchParams } from "@/lib/xmatrix-proxy";

export const GET = hubRouteHandlerFrom(
  "GET",
  ({ channelId }: { channelId: string }, url) => withSearchParams(HUB_ROUTES.channel_history(channelId), url.searchParams),
  { streamResponse: true },
);

import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandlerFrom } from "@/lib/xmatrix-proxy";

/** A settings card's settings, and one made on it; the Hub decides what the card is and who may make each. */
const route = ({ channelId, messageId }: { channelId: string; messageId: string }, url: URL) =>
  `${HUB_ROUTES.channel_settings_card(channelId, messageId)}${url.search}`;

export const GET = hubRouteHandlerFrom("GET", route);
export const PUT = hubRouteHandlerFrom("PUT", route);

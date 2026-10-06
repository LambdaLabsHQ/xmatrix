import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler, proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

type MessageParams = { channelId: string; messageId: string };

export const PATCH = hubRouteHandler("PATCH", HUB_ROUTES.channel_message, ["channelId", "messageId"]);

export async function DELETE(request: Request, context: { params: Promise<MessageParams> }) {
  const { channelId, messageId } = await context.params;
  return proxyXMatrixRequest({
    route: HUB_ROUTES.channel_message(channelId, messageId),
    method: "DELETE",
    authorization: request.headers.get("authorization") || undefined,
    body: "{}",
  });
}

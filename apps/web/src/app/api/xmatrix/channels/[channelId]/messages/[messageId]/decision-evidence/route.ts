import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request, context: { params: Promise<{ channelId: string; messageId: string }> }) {
  const { channelId, messageId } = await context.params;
  const query = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const key of ["refId", "after"]) if (query.has(key)) forwarded.set(key, query.get(key)!);
  return proxyXMatrixRequest({
    route: `${HUB_ROUTES.channel_message_decision_evidence(channelId, messageId)}${forwarded.size ? `?${forwarded}` : ""}`,
    method: "GET", authorization: request.headers.get("authorization") || undefined,
    responseHeaders: ["content-disposition"],
  });
}

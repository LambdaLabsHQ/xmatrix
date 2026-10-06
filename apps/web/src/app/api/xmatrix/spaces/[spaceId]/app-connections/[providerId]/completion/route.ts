import {
  HUB_ROUTES,
  type AppConnectorCompletionDynamicSource,
} from "@xmatrix/protocol";
import { forwardXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(
  request: Request,
  context: { params: Promise<{ spaceId: string; providerId: string }> }
) {
  const { spaceId, providerId } = await context.params;
  const url = new URL(request.url);
  const source = url.searchParams.get("source") as AppConnectorCompletionDynamicSource | null;
  const channelId = url.searchParams.get("channelId") || "";
  const parent = url.searchParams.get("parent") || undefined;
  if (!source || !channelId) {
    return Response.json({ error: "source and channelId are required" }, { status: 400 });
  }
  return forwardXMatrixRequest(request, {
    route: HUB_ROUTES.space_app_connection_completion(
      spaceId,
      providerId,
      source,
      channelId,
      parent
    ),
    method: "GET",
  });
}

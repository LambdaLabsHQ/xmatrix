import { HUB_ROUTES } from "@xmatrix/protocol";
import { forwardXMatrixRequest } from "@/lib/xmatrix-proxy";

type Context = { params: Promise<{ instanceId: string }> };

async function forward(method: "PATCH" | "DELETE", request: Request, context: Context) {
  const query = new URL(request.url).searchParams;
  const spaceId = query.get("spaceId")?.trim();
  const channelId = query.get("channelId")?.trim();
  if (!spaceId || !channelId) return Response.json({ error: "spaceId and channelId are required" }, { status: 400 });
  const { instanceId } = await context.params;
  return forwardXMatrixRequest(request, { route: HUB_ROUTES.agent_instance(spaceId, channelId, instanceId), method });
}

export const PATCH = (request: Request, context: Context) => forward("PATCH", request, context);
export const DELETE = (request: Request, context: Context) => forward("DELETE", request, context);

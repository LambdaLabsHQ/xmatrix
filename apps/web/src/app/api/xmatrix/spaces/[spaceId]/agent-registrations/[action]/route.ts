import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request, context: { params: Promise<{ spaceId: string; action: string }> }) {
  const { spaceId, action } = await context.params;
  if (action !== "commands" && action !== "query") return new Response("Not found", { status: 404 });
  return proxyXMatrixRequest({ route: action === "commands" ? HUB_ROUTES.space_agent_registration_command(spaceId)
    : HUB_ROUTES.space_agent_registration_query(spaceId), method: "POST",
  authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

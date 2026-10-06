import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (action !== "commands" && action !== "query") return new Response("Not found", { status: 404 });
  return proxyXMatrixRequest({ route: action === "commands" ? HUB_ROUTES.agent_environment_command
    : HUB_ROUTES.agent_environment_query, method: "POST",
  authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

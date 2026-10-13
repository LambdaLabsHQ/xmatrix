import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request, context: { params: Promise<{ spaceId: string; action: string }> }) {
  const { spaceId, action } = await context.params;
  const routes: Record<string, ((spaceId: string) => string) | undefined> = {
    commands: HUB_ROUTES.space_agent_registration_command, query: HUB_ROUTES.space_agent_registration_query,
    profiles: HUB_ROUTES.space_harness_profile_command };
  const route = Object.hasOwn(routes, action) ? routes[action] : undefined;
  if (!route) return new Response("Not found", { status: 404 });
  return proxyXMatrixRequest({ route: route(spaceId), method: "POST",
  authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

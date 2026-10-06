import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request, context: { params: Promise<{ channelId: string; action: string }> }) {
  const { channelId, action } = await context.params;
  if (action !== "plan" && action !== "dispatch") return new Response("Not found", { status: 404 });
  return proxyXMatrixRequest({ route: `/api/channels/${encodeURIComponent(channelId)}/agent-routing/${action}`,
    method: "POST", authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(
  request: Request,
  context: { params: Promise<{ instanceId: string }> }
) {
  const { instanceId } = await context.params;
  const url = new URL(request.url);
  const params = new URLSearchParams();
  const limit = url.searchParams.get("limit");
  const since = url.searchParams.get("since");
  const before = url.searchParams.get("before");
  const waitMs = url.searchParams.get("waitMs");
  if (limit) params.set("limit", limit);
  if (since) params.set("since", since);
  if (before) params.set("before", before);
  if (waitMs) params.set("waitMs", waitMs);

  const route = `${HUB_ROUTES.trace_instance_events(instanceId)}${params.toString() ? `?${params}` : ""}`;

  return proxyXMatrixRequest({
    route,
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

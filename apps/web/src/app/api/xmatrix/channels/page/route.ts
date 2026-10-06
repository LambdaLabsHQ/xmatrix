import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request) {
  const source = new URL(request.url);
  const params = new URLSearchParams();
  for (const field of ["spaceId", "view", "filter", "scopeChannelId", "query", "cursor", "includeCounts", "countsOnly"] as const) {
    const value = source.searchParams.get(field);
    if (value) params.set(field, value);
  }
  const query = params.toString();
  return proxyXMatrixRequest({
    route: `${HUB_ROUTES.channel_catalog_page}${query ? `?${query}` : ""}`,
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

import { ADMIN_OVERVIEW_HUB_ROUTE } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

const FORWARDED_PARAMS = ["spaceLimit", "userLimit", "activityDays"] as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }

  const route = params.toString()
    ? `${ADMIN_OVERVIEW_HUB_ROUTE}?${params}`
    : ADMIN_OVERVIEW_HUB_ROUTE;

  return proxyXMatrixRequest({
    route,
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

import { ADMIN_AUDIT_HUB_ROUTE } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request) {
  const limit = new URL(request.url).searchParams.get("limit");
  return proxyXMatrixRequest({
    route: limit ? `${ADMIN_AUDIT_HUB_ROUTE}?${new URLSearchParams({ limit })}` : ADMIN_AUDIT_HUB_ROUTE,
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

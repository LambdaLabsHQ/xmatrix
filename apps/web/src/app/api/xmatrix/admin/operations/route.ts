import { ADMIN_OPERATIONS_HUB_ROUTE } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request) {
  return proxyXMatrixRequest({
    route: ADMIN_OPERATIONS_HUB_ROUTE,
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

import { adminUserDetailHubRoute } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return proxyXMatrixRequest({
    route: adminUserDetailHubRoute(userId),
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

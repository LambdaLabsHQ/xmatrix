import { adminSpaceDetailHubRoute } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request, { params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return proxyXMatrixRequest({
    route: adminSpaceDetailHubRoute(spaceId),
    method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

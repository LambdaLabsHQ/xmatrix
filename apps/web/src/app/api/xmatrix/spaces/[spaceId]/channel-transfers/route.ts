import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request,
  { params }: { params: Promise<{ spaceId: string }> }) {
  const { spaceId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.space_channel_transfers(spaceId) + new URL(request.url).search, method: "GET",
    authorization: request.headers.get("authorization") || undefined,
  });
}

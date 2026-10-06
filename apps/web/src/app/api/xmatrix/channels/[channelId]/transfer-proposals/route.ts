import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request,
  { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.channel_transfer_proposals(channelId), method: "POST",
    authorization: request.headers.get("authorization") || undefined,
    body: await request.text(),
  });
}

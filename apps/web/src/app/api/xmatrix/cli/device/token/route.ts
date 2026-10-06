import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request) {
  return proxyXMatrixRequest({
    route: HUB_ROUTES.device_token,
    method: "POST",
    body: await request.text(),
  });
}

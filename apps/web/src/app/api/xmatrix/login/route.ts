import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request) {
  return proxyXMatrixRequest({
    route: HUB_ROUTES.login,
    method: "POST",
    body: await request.text(),
  });
}

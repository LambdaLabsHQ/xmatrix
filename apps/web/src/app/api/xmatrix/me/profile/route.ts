import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export async function PATCH(request: Request) {
  return proxyXMatrixRequest({
    route: HUB_ROUTES.me_profile,
    method: "PATCH",
    body: await request.text(),
  });
}

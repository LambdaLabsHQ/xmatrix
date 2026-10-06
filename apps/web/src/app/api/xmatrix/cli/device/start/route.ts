import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST() {
  return proxyXMatrixRequest({
    route: HUB_ROUTES.device_start,
    method: "POST",
  });
}

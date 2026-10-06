import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export async function POST(request: Request) {
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine_harness_actions, method: "POST",
    authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

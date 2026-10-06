import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export async function GET(request: Request, { params }: { params: Promise<{ controlId: string }> }) {
  const { controlId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine_harness_action(controlId),
    method: "GET", authorization: request.headers.get("authorization") || undefined });
}

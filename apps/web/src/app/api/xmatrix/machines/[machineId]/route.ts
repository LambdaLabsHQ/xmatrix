import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function DELETE(request: Request, { params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine(machineId), method: "DELETE",
    authorization: request.headers.get("authorization") || undefined });
}

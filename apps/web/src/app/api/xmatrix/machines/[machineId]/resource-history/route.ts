import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(request: Request, { params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  const range = new URL(request.url).searchParams.get("range");
  return proxyXMatrixRequest({
    route: `${HUB_ROUTES.machine_resource_history(machineId)}${range ? `?range=${encodeURIComponent(range)}` : ""}`,
    method: "GET", authorization: request.headers.get("authorization") || undefined });
}

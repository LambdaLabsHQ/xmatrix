import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES } from "@xmatrix/protocol";

export async function POST(request: Request) {
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine_harness_actions, method: "POST",
    authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

export async function GET(request: Request) {
  const machineId = new URL(request.url).searchParams.get("machineId") ?? "";
  return proxyXMatrixRequest({ route: `${HUB_ROUTES.machine_harness_actions}?machineId=${encodeURIComponent(machineId)}`,
    method: "GET", authorization: request.headers.get("authorization") || undefined });
}

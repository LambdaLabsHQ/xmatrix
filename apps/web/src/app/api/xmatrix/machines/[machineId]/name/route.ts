import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function PUT(request: Request, { params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine_name(machineId), method: "PUT",
    authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

export async function POST(request: Request, { params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine_name(machineId), method: "POST",
    authorization: request.headers.get("authorization") || undefined, body: await request.text() });
}

export async function GET(request: Request, { params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  return proxyXMatrixRequest({ route: HUB_ROUTES.machine_name(machineId), method: "GET",
    authorization: request.headers.get("authorization") || undefined });
}

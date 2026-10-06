import { HUB_ROUTES } from "@xmatrix/protocol";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  return proxyXMatrixRequest({
    route: HUB_ROUTES.space_invite(token),
    method: "GET",
  });
}

import { RELAY_V2_BLOB_UPLOAD_INTENT_PATH } from "@xmatrix/protocol/relay-v2/message-attachment";
import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";

export async function POST(request: Request) {
  return proxyXMatrixRequest({
    route: RELAY_V2_BLOB_UPLOAD_INTENT_PATH,
    method: "POST",
    authorization: request.headers.get("authorization") || undefined,
    body: await request.text(),
  });
}

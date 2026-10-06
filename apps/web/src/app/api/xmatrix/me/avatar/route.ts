import { proxyXMatrixRequest } from "@/lib/xmatrix-proxy";
import { HUB_ROUTES, HUMAN_AVATAR_MAX_BYTES, humanAvatarMimeType } from "@xmatrix/protocol";

/* The image bytes are forwarded untouched. Type and size are re-checked here
   only to fail a bad request before it costs a Hub round trip; the Hub repeats
   both checks, and its copy is the one that decides, because this proxy is not
   the only way to reach the route. */
export async function POST(request: Request) {
  const mimeType = humanAvatarMimeType(request.headers.get("content-type"));
  if (!mimeType) {
    return Response.json(
      { code: "avatar_type_unsupported", message: "Upload a PNG, JPEG, or WebP image" },
      { status: 415 },
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > HUMAN_AVATAR_MAX_BYTES) {
    return Response.json({ code: "avatar_too_large", message: "Image is too large" }, { status: 413 });
  }
  return proxyXMatrixRequest({
    route: HUB_ROUTES.me_avatar,
    method: "POST",
    headers: { "content-type": mimeType },
    body,
  });
}

export async function DELETE() {
  return proxyXMatrixRequest({ route: HUB_ROUTES.me_avatar, method: "DELETE" });
}

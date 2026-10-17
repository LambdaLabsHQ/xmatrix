import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import { NATIVE_REFRESH_COOKIE } from "@/lib/native-session";
import { nativeAccountPath } from "@/lib/native-account-proxy";

/** Sends a native app page's account call on with the app's own session (lib/native-account-proxy.ts). */
async function forward(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const path = nativeAccountPath((await context.params).path ?? []);
  if (!path) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The session rides on a cookie, so a write must come from this site's own pages.
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  }
  const refreshToken = (await cookies()).get(NATIVE_REFRESH_COOKIE)?.value?.trim();
  const target = new URL(`/api/auth/${path}`, getXMatrixHubUrl());
  target.search = new URL(request.url).search;
  const response = await fetch(target, {
    method: request.method,
    headers: {
      accept: "application/json",
      ...(request.method === "GET" ? {} : { "content-type": request.headers.get("content-type") ?? "application/json" }),
      ...(refreshToken ? { authorization: `Bearer ${refreshToken}` } : {}),
    },
    ...(request.method === "GET" ? {} : { body: await request.text() }),
    cache: "no-store",
    redirect: "manual",
  });
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  });
  // A GitHub link keeps its provider state in the browser, as a cookie of the shared parent domain.
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new NextResponse(response.body, { status: response.status, headers });
}

export const GET = forward;
export const POST = forward;

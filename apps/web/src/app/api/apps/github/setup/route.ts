import { NextResponse } from "next/server";
import { withRoute } from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";

export function GET(request: Request) {
  const url = new URL(request.url);
  const callbackUrl = new URL(withRoute(getXMatrixHubUrl(), "/api/apps/github/setup"));
  callbackUrl.search = url.search;
  return NextResponse.redirect(callbackUrl, 302);
}

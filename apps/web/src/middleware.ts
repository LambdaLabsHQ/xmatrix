import { NextResponse, type NextRequest } from "next/server";
import { isAppShellPath } from "@/lib/app-shell-route";

export function middleware(request: NextRequest) {
  if (isAppShellPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/workspace";
    return NextResponse.rewrite(url, { request });
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     * - public assets
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

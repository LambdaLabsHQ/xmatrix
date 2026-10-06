import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const rewriteUrl = getAppRewriteUrl(request);
  if (rewriteUrl) {
    return NextResponse.rewrite(rewriteUrl, { request });
  }

  return NextResponse.next({ request });
}

function getAppRewriteUrl(request: NextRequest) {
  if (request.nextUrl.pathname !== "/app") {
    return null;
  }

  const url = request.nextUrl.clone();
  url.pathname = "/workspace";
  return url;
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

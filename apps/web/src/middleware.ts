import { NextResponse, type NextRequest } from "next/server";
import { findAlternativePageByRouteSlug, findAlternativeRedirect } from "@/lib/alternatives";
import { isAppShellPath } from "@/lib/app-shell-route";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAppShellPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/workspace";
    return NextResponse.rewrite(url, { request });
  }

  // Direct requests to the internal `/alternatives` render prefix are never public.
  if (pathname === "/alternatives" || pathname.startsWith("/alternatives/")) {
    return new NextResponse(null, { status: 404 });
  }

  // Flat root-level competitor landing pages: `/raft-alternatives`, `/t3-code-alternatives`, …
  if (pathname.endsWith("-alternatives") && !pathname.slice(1).includes("/")) {
    const routeSlug = pathname.slice(1);
    const redirectTarget = findAlternativeRedirect(routeSlug);
    if (redirectTarget) {
      const target = request.nextUrl.clone();
      target.pathname = redirectTarget;
      return NextResponse.redirect(target, 308);
    }
    if (findAlternativePageByRouteSlug(routeSlug)) {
      const url = request.nextUrl.clone();
      url.pathname = `/alternatives/${routeSlug}`;
      return NextResponse.rewrite(url, { request });
    }
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

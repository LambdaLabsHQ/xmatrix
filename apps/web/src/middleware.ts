import { NextResponse, type NextRequest } from "next/server";
import { findAlternativePageByRouteSlug, findAlternativeRedirect } from "@/lib/alternatives";
import { isAppShellPath } from "@/lib/app-shell-route";
import { isNonDefaultSiteLocale, localizedPath, type SiteLocale } from "@/lib/site-locales";

function handleAlternativeRoute(
  request: NextRequest,
  routeSlug: string,
  locale: SiteLocale,
): NextResponse | null {
  const redirectTarget = findAlternativeRedirect(routeSlug);
  if (redirectTarget) {
    const target = request.nextUrl.clone();
    target.pathname = localizedPath(locale, redirectTarget);
    return NextResponse.redirect(target, 308);
  }
  if (findAlternativePageByRouteSlug(routeSlug, locale)) {
    const url = request.nextUrl.clone();
    url.pathname = locale === "en" ? `/alternatives/${routeSlug}` : `/loc/${locale}/alternatives/${routeSlug}`;
    return NextResponse.rewrite(url, { request });
  }
  return null;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAppShellPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/workspace";
    return NextResponse.rewrite(url, { request });
  }

  // Internal render prefixes are never publicly addressable directly.
  if (
    pathname === "/loc" ||
    pathname.startsWith("/loc/") ||
    pathname === "/alternatives" ||
    pathname.startsWith("/alternatives/")
  ) {
    return new NextResponse(null, { status: 404 });
  }

  // Flat root-level English competitor landing pages: `/raft-alternatives`, …
  if (pathname.endsWith("-alternatives") && !pathname.slice(1).includes("/")) {
    const response = handleAlternativeRoute(request, pathname.slice(1), "en");
    if (response) return response;
  }

  // Localized public routes: `/zh`, `/zh-tw`, `/ja`, `/ko`, `/es` and their subpaths.
  const segments = pathname.slice(1).split("/");
  const maybeLocale = segments[0];
  if (maybeLocale && isNonDefaultSiteLocale(maybeLocale)) {
    const rest = segments.slice(1);
    if (rest.length === 0) {
      const url = request.nextUrl.clone();
      url.pathname = `/loc/${maybeLocale}`;
      return NextResponse.rewrite(url, { request });
    }
    const [head, ...tail] = rest;
    if (head === "alternatives") {
      return new NextResponse(null, { status: 404 });
    }
    if (tail.length === 0 && head && head.endsWith("-alternatives")) {
      const response = handleAlternativeRoute(request, head, maybeLocale);
      if (response) return response;
    }
    if (
      (head === "download" && tail.length === 0) ||
      (head === "support" && tail.length === 0) ||
      head === "docs"
    ) {
      const url = request.nextUrl.clone();
      url.pathname = `/loc/${maybeLocale}/${rest.join("/")}`;
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

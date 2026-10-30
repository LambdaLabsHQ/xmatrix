/*
 * A deployment can serve the marketing site at its own origin (`web.siteOrigin`
 * in the deploy profile) beside the app's. Only the site's own pages answer
 * there; sign-in and every signed-in surface live at the app origin, whose
 * cookie domain the site origin is outside of, so every other path is sent
 * there. Unknown paths go to the app origin too, where everything still works.
 */

/** Exact paths of the site's pages and files. */
const SITE_PATHS = new Set([
  "/", "/zh", "/download", "/terms", "/privacy", "/subprocessors", "/cookies",
  "/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/site.webmanifest",
  "/favicon.ico", "/apple-touch-icon.png", "/install.sh", "/install.ps1",
]);

/** Path prefixes of the site's pages, its assets and the public API its pages read. */
const SITE_PREFIXES = [
  "/docs/", "/releases/", "/_next/", "/api/", "/brand/", "/fonts/", "/textures/",
  "/agent-vendors/", "/app-connectors/", "/role-avatars/", "/skills/", "/prompts/",
];

/** Top-level files: the Markdown the site publishes, app icons and search-engine key files. */
const SITE_FILE = /^\/(?:[a-z0-9-]+\.md|(?:icon|android-chrome)-[0-9x]+\.png|[0-9a-f]{32}\.txt)$/u;

export function isSitePath(pathname) {
  if (SITE_PATHS.has(pathname) || pathname === "/docs" || pathname === "/releases") return true;
  return SITE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || SITE_FILE.test(pathname);
}

/**
 * The redirect a request at the site origin gets when it asks for something
 * other than the site; null when it is served where it arrived.
 */
export function siteOriginRedirect(url, env) {
  const site = env?.XMATRIX_SITE_ORIGIN;
  const app = env?.XMATRIX_APP_ORIGIN;
  if (!site || !app) return null;
  const siteHost = new URL(site).host;
  const appOrigin = new URL(app);
  if (url.host !== siteHost || appOrigin.host === siteHost || isSitePath(url.pathname)) return null;
  // Temporary: which paths the site serves may change, and browsers must not remember the answer.
  return Response.redirect(new URL(`${url.pathname}${url.search}`, appOrigin).href, 302);
}

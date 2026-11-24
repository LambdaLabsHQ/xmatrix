/** Origin of the Web app, where sign-in and every signed-in surface live. */
export const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://xmatrix.sh");

/**
 * Public origin of the marketing site; metadata, canonical URLs, robots and sitemap resolve against it. A deployment
 * can serve the site at its own origin too (`web.siteOrigin` in the deploy profile); it is then this one on either.
 */
export const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL || appUrl.href);

/**
 * A link from a public site page into the Web app (/app, /login, /console…). Where the site has its own origin, that
 * origin forwards app addresses to the app with a 302, so the link names the app origin itself instead.
 */
export function appHref(path: `/${string}`): string {
  return siteUrl.origin === appUrl.origin ? path : new URL(path, appUrl).href;
}

/** The beta Web, which every beta deploys; search engines index only the stable one. */
/** The card a link to the site shows when it is shared: 1200×630, the size every network renders large. */
export const shareImage = {
  url: "/brand/xmatrix-share-card.jpg",
  width: 1200,
  height: 630,
  alt: "xMatrix — Multi-agent collaboration around live documents",
};

export const isBetaWeb = process.env.NEXT_PUBLIC_XMATRIX_WEB_CHANNEL === "beta";

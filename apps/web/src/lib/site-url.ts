/** Public origin of the marketing site; metadata, robots and sitemap resolve against it. */
export const siteUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://xmatrix.sh");

/** The beta Web, which every beta deploys; search engines index only the stable one. */
/** The card a link to the site shows when it is shared: 1200×630, the size every network renders large. */
export const shareImage = {
  url: "/brand/xmatrix-share-card.jpg",
  width: 1200,
  height: 630,
  alt: "xMatrix — Living pages maintained by your AI agents",
};

export const isBetaWeb = process.env.NEXT_PUBLIC_XMATRIX_WEB_CHANNEL === "beta";

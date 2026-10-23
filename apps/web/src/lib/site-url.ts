/** Public origin of the marketing site; metadata, robots and sitemap resolve against it. */
export const siteUrl = new URL(process.env.NEXT_PUBLIC_APP_URL || "https://xmatrix.sh");

/** The beta Web, which every beta deploys; search engines index only the stable one. */
export const isBetaWeb = process.env.NEXT_PUBLIC_XMATRIX_WEB_CHANNEL === "beta";

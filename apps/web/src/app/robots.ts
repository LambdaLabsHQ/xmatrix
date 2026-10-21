import type { MetadataRoute } from "next";
import { isBetaWeb, siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  if (isBetaWeb) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Signed-in surfaces and auth callbacks have nothing for a crawler.
      disallow: ["/api/", "/app$", "/app/", "/workspace", "/console", "/billing", "/connect/", "/spaces/", "/dev/"],
    },
    sitemap: new URL("/sitemap.xml", siteUrl).href,
  };
}

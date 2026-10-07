import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
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

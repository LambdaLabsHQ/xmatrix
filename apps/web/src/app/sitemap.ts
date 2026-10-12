import type { MetadataRoute } from "next";
import { guidePages } from "@/lib/docs/guide";
import { siteUrl } from "@/lib/site-url";

const publicPaths = ["/", ...guidePages.map((page) => page.href), "/download", "/terms", "/privacy", "/subprocessors", "/cookies"];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths.map((path) => ({ url: new URL(path, siteUrl).href }));
}

import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";

const publicPaths = ["/", "/docs", "/download", "/terms", "/privacy", "/subprocessors", "/cookies"];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths.map((path) => ({ url: new URL(path, siteUrl).href }));
}

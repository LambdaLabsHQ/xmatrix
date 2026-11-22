import type { MetadataRoute } from "next";
import { alternativePages } from "@/lib/alternatives";
import { guidePages } from "@/lib/docs/guide";
import { siteUrl } from "@/lib/site-url";

const publicPaths = [
  "/",
  "/zh",
  "/alternatives",
  ...alternativePages.map((page) => page.href),
  ...guidePages.map((page) => page.href),
  "/download",
  "/support",
  "/terms",
  "/privacy",
  "/subprocessors",
  "/cookies",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths.map((path) => ({ url: new URL(path, siteUrl).href }));
}

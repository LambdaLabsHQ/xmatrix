import type { MetadataRoute } from "next";
import { isBetaWeb, siteUrl } from "@/lib/site-url";

/**
 * High-volume scraper crawlers kept disallowed (mirrored in Cloudflare AI Crawl
 * Control). Search engines in every language (Google, Bing, Baidu, Sogou, 360,
 * Shenma, Petal, Yandex…), AI search crawlers (OAI-SearchBot, Claude-SearchBot,
 * PerplexityBot), and mainstream AI training crawlers (GPTBot, ClaudeBot,
 * Google-Extended, CCBot…) stay allowed so public docs enter model corpora.
 * This file is the site's only robots policy: Cloudflare's managed robots.txt
 * stays off so it cannot add a second one.
 */
const blockedScrapers = ["Amazonbot", "Bytespider", "TikTokSpider"];

export default function robots(): MetadataRoute.Robots {
  if (isBetaWeb) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: [
      { userAgent: blockedScrapers, disallow: "/" },
      {
        userAgent: "*",
        allow: "/",
        // Signed-in surfaces and auth callbacks have nothing for a crawler.
        disallow: ["/api/", "/app$", "/app/", "/workspace", "/console", "/billing", "/connect/", "/spaces/", "/dev/"],
      },
    ],
    sitemap: new URL("/sitemap.xml", siteUrl).href,
  };
}

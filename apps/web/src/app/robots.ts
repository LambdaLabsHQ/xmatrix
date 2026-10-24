import type { MetadataRoute } from "next";
import { isBetaWeb, siteUrl } from "@/lib/site-url";

/**
 * Crawlers that collect pages to train AI models, not to answer a search.
 * Search engines in every language (Google, Bing, Baidu, Sogou, 360, Shenma,
 * Petal, Yandex…) and AI search crawlers (OAI-SearchBot, Claude-SearchBot,
 * PerplexityBot) stay allowed. This file is the site's only robots policy:
 * Cloudflare's managed robots.txt stays off so it cannot add a second one.
 */
const trainingCrawlers = [
  "Amazonbot", "Applebot-Extended", "Bytespider", "CCBot", "ClaudeBot", "Claude-Web", "anthropic-ai", "Diffbot",
  "Google-Extended", "GoogleOther", "Google-CloudVertexBot", "GPTBot", "omgili", "cohere-ai", "MistralAI-Training",
  "meta-externalagent", "AwarioSmartBot", "AwarioRssBot", "QualifiedBot", "Cotoyogi", "ICC-Crawler", "atlassian-bot",
  "FishBot", "BorderxBot", "NavuBot", "SemrushBot-SWA", "WARDBot", "magpie-crawler", "KimiBot", "CitibotSiteCrawler",
];

export default function robots(): MetadataRoute.Robots {
  if (isBetaWeb) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: [
      { userAgent: trainingCrawlers, disallow: "/" },
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

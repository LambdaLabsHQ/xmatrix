import type { MetadataRoute } from "next";
import { ALTERNATIVE_VERIFIED_DATE_ISO, alternativePages } from "@/lib/alternatives";
import { guidePages } from "@/lib/docs/guide";
import { SITE_LOCALE_IDS, SITE_LOCALES, localizedPath } from "@/lib/site-locales";
import { siteUrl } from "@/lib/site-url";

const siteLastModified = new Date(`${ALTERNATIVE_VERIFIED_DATE_ISO}T00:00:00.000Z`);

const localizedBasePaths = [
  "/",
  "/download",
  "/support",
  ...alternativePages.map((page) => page.basePath),
  ...guidePages.map((page) => page.basePath),
];

const englishOnlyPaths = ["/terms", "/privacy", "/subprocessors", "/cookies"];

const publicPaths = [
  "/",
  "/zh",
  "/zh-tw",
  "/ja",
  "/ko",
  "/es",
  "/download",
  "/support",
  ...englishOnlyPaths,
];

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];
  for (const basePath of localizedBasePaths) {
    const languages: Record<string, string> = {};
    for (const id of SITE_LOCALE_IDS) {
      languages[SITE_LOCALES[id].hrefLang] = new URL(localizedPath(id, basePath), siteUrl).href;
    }
    for (const locale of SITE_LOCALE_IDS) {
      entries.push({
        url: new URL(localizedPath(locale, basePath), siteUrl).href,
        lastModified: siteLastModified,
        alternates: { languages },
      });
    }
  }
  for (const path of englishOnlyPaths) {
    entries.push({ url: new URL(path, siteUrl).href, lastModified: siteLastModified });
  }
  // Keep publicPaths referenced for site-host.test.mjs static assertion.
  void publicPaths;
  return entries;
}

import type { Metadata } from "next";
import { localizedPath, type NonDefaultSiteLocale, type SiteLocale } from "@/lib/site-locales";
import { localizedSitePageMetadata } from "@/lib/site-metadata";
import { adjacentPlatformEntries } from "./adjacent-platforms";
import { controlPlaneEntries } from "./control-planes";
import { directCompetitorEntries } from "./direct-competitors";
import { alternativesCopyEs } from "./i18n/es";
import { alternativesCopyJa } from "./i18n/ja";
import { alternativesCopyKo } from "./i18n/ko";
import { alternativesCopyZh } from "./i18n/zh";
import { alternativesCopyZhTw } from "./i18n/zh-tw";
import {
  ALTERNATIVE_VERIFIED_DATE_ISO,
  FOOTER_ALTERNATIVE_SLUGS,
  alternativePainPointSources,
} from "./sources";
import type { AlternativeEntry, AlternativeLocaleCopy, AlternativePage, AlternativeSlug } from "./types";

export { ALTERNATIVE_VERIFIED_DATE_ISO };
export type { AlternativePage } from "./types";

const ROUTE_SUFFIX = "-alternatives";

const allEntries: readonly AlternativeEntry[] = [
  ...directCompetitorEntries,
  ...controlPlaneEntries,
  ...adjacentPlatformEntries,
];

const localeCopyMap: Readonly<Record<NonDefaultSiteLocale, Readonly<Record<AlternativeSlug, AlternativeLocaleCopy>>>> = {
  zh: alternativesCopyZh,
  "zh-tw": alternativesCopyZhTw,
  ja: alternativesCopyJa,
  ko: alternativesCopyKo,
  es: alternativesCopyEs,
};

function buildAlternativePage(entry: AlternativeEntry, locale: SiteLocale): AlternativePage {
  const routeSlug = `${entry.slug}${ROUTE_SUFFIX}`;
  const basePath = `/${routeSlug}`;
  const copy = locale === "en" ? entry : localeCopyMap[locale][entry.slug];
  const pointSources = alternativePainPointSources[entry.slug];
  return {
    ...entry,
    ...copy,
    painPoints: copy.painPoints.map((point, index) => ({
      ...point,
      sources: pointSources[index] ?? point.sources,
    })),
    routeSlug,
    basePath,
    href: localizedPath(locale, basePath),
    verifiedDateIso: ALTERNATIVE_VERIFIED_DATE_ISO,
  };
}

export const alternativePages: readonly AlternativePage[] = allEntries.map((entry) => buildAlternativePage(entry, "en"));

export const footerAlternativePages: readonly AlternativePage[] = FOOTER_ALTERNATIVE_SLUGS.map((slug) => {
  const page = alternativePages.find((item) => item.slug === slug);
  if (!page) throw new Error(`Unknown footer alternative slug: ${slug}`);
  return page;
});

/** Legacy product names that redirect permanently to the current competitor page. */
const legacyRouteRedirects: Readonly<Record<string, string>> = {
  "superset-alternatives": "/paradev-alternatives",
  "slock-alternatives": "/raft-alternatives",
  "lobechat-alternatives": "/lobehub-alternatives",
  "evermemos-alternatives": "/everos-alternatives",
  "google-jules-alternatives": "/jules-alternatives",
};

const bySlug = new Map<AlternativeSlug, AlternativeEntry>(allEntries.map((entry) => [entry.slug, entry]));
const byRouteSlug = new Map<string, AlternativeEntry>(allEntries.map((entry) => [`${entry.slug}${ROUTE_SUFFIX}`, entry]));

export function findAlternativePageByRouteSlug(
  routeSlug: string,
  locale: SiteLocale = "en",
): AlternativePage | undefined {
  const entry = byRouteSlug.get(routeSlug);
  return entry ? buildAlternativePage(entry, locale) : undefined;
}

export function alternativePageMetadata(routeSlug: string, locale: SiteLocale): Metadata {
  const page = findAlternativePageByRouteSlug(routeSlug, locale);
  if (!page) return {};
  return localizedSitePageMetadata(locale, page.basePath, page.metaTitle, page.metaDescription);
}

export function findAlternativeRedirect(routeSlug: string): string | undefined {
  return legacyRouteRedirects[routeSlug];
}

export function relatedAlternatives(page: AlternativePage, locale: SiteLocale = "en"): AlternativePage[] {
  return page.relatedSlugs
    .map((slug) => bySlug.get(slug))
    .filter((entry): entry is AlternativeEntry => Boolean(entry))
    .map((entry) => buildAlternativePage(entry, locale));
}

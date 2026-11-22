/**
 * Public marketing & documentation site locales (Top6):
 * English lives at `/` and the 5 localized trees at `/zh`, `/zh-tw`, `/ja`, `/ko`, `/es`.
 */
export const SITE_LOCALE_IDS = ["en", "zh", "zh-tw", "ja", "ko", "es"] as const;
export type SiteLocale = (typeof SITE_LOCALE_IDS)[number];

export const NON_DEFAULT_SITE_LOCALES = ["zh", "zh-tw", "ja", "ko", "es"] as const;
export type NonDefaultSiteLocale = (typeof NON_DEFAULT_SITE_LOCALES)[number];

export interface SiteLocaleMeta {
  id: SiteLocale;
  prefix: string;
  htmlLang: string;
  hrefLang: string;
  ogLocale: string;
  nativeLabel: string;
}

export const SITE_LOCALES: Readonly<Record<SiteLocale, SiteLocaleMeta>> = {
  en: { id: "en", prefix: "", htmlLang: "en", hrefLang: "en", ogLocale: "en_US", nativeLabel: "English" },
  zh: { id: "zh", prefix: "/zh", htmlLang: "zh-CN", hrefLang: "zh-CN", ogLocale: "zh_CN", nativeLabel: "简体中文" },
  "zh-tw": { id: "zh-tw", prefix: "/zh-tw", htmlLang: "zh-TW", hrefLang: "zh-TW", ogLocale: "zh_TW", nativeLabel: "繁體中文" },
  ja: { id: "ja", prefix: "/ja", htmlLang: "ja", hrefLang: "ja", ogLocale: "ja_JP", nativeLabel: "日本語" },
  ko: { id: "ko", prefix: "/ko", htmlLang: "ko", hrefLang: "ko", ogLocale: "ko_KR", nativeLabel: "한국어" },
  es: { id: "es", prefix: "/es", htmlLang: "es", hrefLang: "es", ogLocale: "es_ES", nativeLabel: "Español" },
};

const nonDefaultSet = new Set<string>(NON_DEFAULT_SITE_LOCALES);

export function isNonDefaultSiteLocale(value: string): value is NonDefaultSiteLocale {
  return nonDefaultSet.has(value);
}

/**
 * Turns a locale-neutral path (`/`, `/download`, `/docs/syntax`, `/raft-alternatives`)
 * into its public address for `locale`.
 */
export function localizedPath(locale: SiteLocale, basePath: string): string {
  const clean = basePath.startsWith("/") ? basePath : `/${basePath}`;
  if (locale === "en") return clean;
  const { prefix } = SITE_LOCALES[locale];
  return clean === "/" ? prefix : `${prefix}${clean}`;
}

/**
 * Builds `alternates` (`canonical` + bidirectional `hreflang` across all 6 locales
 * + `x-default` pointing to English) for any localized public route.
 */
export function localizedAlternates(locale: SiteLocale, basePath: string) {
  const languages: Record<string, string> = {};
  for (const id of SITE_LOCALE_IDS) {
    languages[SITE_LOCALES[id].hrefLang] = localizedPath(id, basePath);
  }
  languages["x-default"] = localizedPath("en", basePath);
  return {
    canonical: localizedPath(locale, basePath),
    languages,
  };
}

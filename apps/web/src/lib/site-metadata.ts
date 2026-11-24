import type { Metadata } from "next";
import { SITE_LOCALES, localizedAlternates, localizedPath, type SiteLocale } from "@/lib/site-locales";
import { shareImage } from "@/lib/site-url";
import { APP_STORE_ID } from "@/lib/app-stores";

/** Safari on iPhone and iPad shows the App Store banner for the phone app on public pages. */
export const smartAppBanner = { itunes: { appId: APP_STORE_ID } } satisfies Metadata;

/** Canonical and sharing metadata name the same page at the public site origin. */
export function sitePageMetadata(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    ...smartAppBanner,
    openGraph: { title, description, url: path, siteName: "xMatrix", type: "website", images: [shareImage] },
  };
}

/**
 * Metadata for a public page published in all 6 site locales (`en`, `zh`,
 * `zh-tw`, `ja`, `ko`, `es`): sets canonical, bidirectional `hreflang` links +
 * `x-default`, OpenGraph locale and share card, and Twitter summary card.
 */
export function localizedSitePageMetadata(
  locale: SiteLocale,
  basePath: string,
  title: string,
  description: string,
  type: "website" | "article" = "website",
): Metadata {
  const url = localizedPath(locale, basePath);
  return {
    title,
    description,
    alternates: localizedAlternates(locale, basePath),
    ...smartAppBanner,
    openGraph: {
      title,
      description,
      url,
      siteName: "xMatrix",
      type,
      locale: SITE_LOCALES[locale].ogLocale,
      images: [shareImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [shareImage],
    },
  };
}

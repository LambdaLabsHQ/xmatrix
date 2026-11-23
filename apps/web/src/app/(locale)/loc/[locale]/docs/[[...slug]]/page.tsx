import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideDocument } from "@/components/docs/guide-document";
import { findGuidePage, guidePageMetadata, guidePagesForLocale } from "@/lib/docs/guide";
import { NON_DEFAULT_SITE_LOCALES, isNonDefaultSiteLocale } from "@/lib/site-locales";

type Params = { params: Promise<{ locale: string; slug?: string[] }> };

/** Prerendered at build, so a crawler or visitor never waits for a cold render. */
export function generateStaticParams() {
  return NON_DEFAULT_SITE_LOCALES.flatMap((locale) =>
    guidePagesForLocale(locale).map((page) => ({ locale, slug: page.file === "index" ? [] : [page.file] })),
  );
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  return isNonDefaultSiteLocale(locale) ? guidePageMetadata(slug, locale) : {};
}

export default async function LocalizedGuidePage({ params }: Params) {
  const { locale, slug } = await params;
  if (!isNonDefaultSiteLocale(locale)) notFound();
  const page = findGuidePage(slug, locale);
  if (!page) notFound();
  return <GuideDocument page={page} locale={locale} />;
}

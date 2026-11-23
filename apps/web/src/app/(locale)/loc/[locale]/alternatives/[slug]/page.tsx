import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlternativeDetailPage } from "@/components/alternatives/alternative-page";
import { alternativePageMetadata, alternativePages, findAlternativePageByRouteSlug } from "@/lib/alternatives";
import { NON_DEFAULT_SITE_LOCALES, isNonDefaultSiteLocale } from "@/lib/site-locales";

type Params = { params: Promise<{ locale: string; slug: string }> };

/** Prerendered at build, so a crawler or visitor never waits for a cold render. */
export function generateStaticParams() {
  return NON_DEFAULT_SITE_LOCALES.flatMap((locale) => alternativePages.map((page) => ({ locale, slug: page.routeSlug })));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, slug } = await params;
  return isNonDefaultSiteLocale(locale) ? alternativePageMetadata(slug, locale) : {};
}

export default async function LocalizedAlternativePage({ params }: Params) {
  const { locale, slug } = await params;
  if (!isNonDefaultSiteLocale(locale)) notFound();
  const page = findAlternativePageByRouteSlug(slug, locale);
  if (!page) notFound();
  return <AlternativeDetailPage page={page} locale={locale} />;
}

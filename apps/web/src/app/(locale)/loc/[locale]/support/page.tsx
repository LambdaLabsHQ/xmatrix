import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SupportPageView, supportPageMetadata } from "@/components/support/support-page";
import { isNonDefaultSiteLocale } from "@/lib/site-locales";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return isNonDefaultSiteLocale(locale) ? supportPageMetadata(locale) : {};
}

export default async function LocalizedSupportPage({ params }: Params) {
  const { locale } = await params;
  if (!isNonDefaultSiteLocale(locale)) notFound();
  return <SupportPageView locale={locale} />;
}

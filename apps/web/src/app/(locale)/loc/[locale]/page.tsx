import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Home, homeMetadata } from "@/components/landing/home";
import { isNonDefaultSiteLocale } from "@/lib/site-locales";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return isNonDefaultSiteLocale(locale) ? homeMetadata(locale) : {};
}

export default async function LocalizedHomePage({ params }: Params) {
  const { locale } = await params;
  if (!isNonDefaultSiteLocale(locale)) notFound();
  return <Home locale={locale} />;
}

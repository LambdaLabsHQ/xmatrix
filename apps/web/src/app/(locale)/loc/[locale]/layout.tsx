import { notFound } from "next/navigation";
import Document from "@/components/site-document";
import { SITE_LOCALES, isNonDefaultSiteLocale } from "@/lib/site-locales";

export { metadata, viewport } from "@/components/site-document";

export default async function LocalizedLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isNonDefaultSiteLocale(locale)) notFound();
  return <Document lang={SITE_LOCALES[locale].htmlLang}>{children}</Document>;
}

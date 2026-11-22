import type { Metadata } from "next";
import { DesktopDownload } from "@/components/landing/desktop-download";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import type { SiteLocale } from "@/lib/site-locales";
import { localizedSitePageMetadata } from "@/lib/site-metadata";
import { sitePagesCopy } from "@/lib/site-pages-copy";

export function downloadPageMetadata(locale: SiteLocale): Metadata {
  const { metaTitle, metaDescription } = sitePagesCopy[locale].download;
  return localizedSitePageMetadata(locale, "/download", metaTitle, metaDescription);
}

export function DownloadPageView({ locale = "en" }: { locale?: SiteLocale }) {
  return (
    <div className="site-page">
      <Navbar locale={locale} />
      <main>
        <DesktopDownload locale={locale} />
      </main>
      <Footer locale={locale} basePath="/download" />
    </div>
  );
}

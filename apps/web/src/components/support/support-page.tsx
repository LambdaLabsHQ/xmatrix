import type { Metadata } from "next";
import Link from "next/link";

import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import { localizedPath, type SiteLocale } from "@/lib/site-locales";
import { localizedSitePageMetadata } from "@/lib/site-metadata";
import { sitePagesCopy } from "@/lib/site-pages-copy";

export function supportPageMetadata(locale: SiteLocale): Metadata {
  const { metaTitle, metaDescription } = sitePagesCopy[locale].support;
  return localizedSitePageMetadata(locale, "/support", metaTitle, metaDescription);
}

export function SupportPageView({ locale = "en" }: { locale?: SiteLocale }) {
  const copy = sitePagesCopy[locale].support;
  return (
    <div className="site-page">
      <Navbar locale={locale} />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-32">
        <article className="page-document" data-editable="false">
          <h1>{copy.title}</h1>
          <p>{copy.intro}</p>
          <h2>{copy.contactHeading}</h2>
          <p>
            {copy.contactBefore}
            <a href="mailto:hello@xmatrix.sh?subject=xMatrix%20support">hello@xmatrix.sh</a>
            {copy.contactAfter}
          </p>
          <p>{copy.bugDetails}</p>
          <h2>{copy.setupHeading}</h2>
          <p>
            {copy.setupBefore}
            <Link href={localizedPath(locale, "/docs")}>{copy.setupLink}</Link>
            {copy.setupAfter}
          </p>
          <h2>{copy.subsHeading}</h2>
          <p>{copy.subsBody}</p>
        </article>
      </main>
      <Footer locale={locale} basePath="/support" />
    </div>
  );
}

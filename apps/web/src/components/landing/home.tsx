import type { Metadata } from "next";
import { Navbar } from "@/components/shared/navbar";
import { Hero } from "@/components/landing/hero";
import { Conversations } from "@/components/landing/conversations";
import { Agents } from "@/components/landing/agents";
import { LivePage } from "@/components/landing/live-page";
import { Why } from "@/components/landing/why";
import { Faq } from "@/components/landing/faq";
import { Closing } from "@/components/landing/closing";
import { Connectors } from "@/components/landing/connectors";
import { Pricing } from "@/components/landing/pricing";
import { Footer, X_ACCOUNT_URL } from "@/components/landing/footer";
import { landingCopy, type Locale } from "@/lib/landing-copy";
import { SITE_LOCALES, localizedAlternates } from "@/lib/site-locales";
import { smartAppBanner } from "@/lib/site-metadata";
import { shareImage, siteUrl } from "@/lib/site-url";
import { REPOSITORY_URL } from "@/lib/star-prompt";

/** Each homepage names itself canonical and points search engines at every locale. */
export function homeMetadata(locale: Locale): Metadata {
  const { home, meta } = landingCopy[locale];
  return {
    title: meta.title,
    description: meta.description,
    alternates: localizedAlternates(locale, "/"),
    ...smartAppBanner,
    openGraph: {
      title: meta.title,
      description: meta.shareDescription,
      url: home,
      type: "website",
      locale: SITE_LOCALES[locale].ogLocale,
      images: [shareImage],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.shareDescription,
      images: [shareImage],
    },
  };
}

/**
 * Who and what the site is, for search engines: the site's name (so results
 * read "xMatrix", not another X-matrix) and its maker. No SoftwareApplication:
 * Google rejects one without a genuine aggregateRating or review, and we have none.
 */
function homeStructuredData(locale: Locale): string {
  const { home, lang, meta } = landingCopy[locale];
  const url = (href: string) => new URL(href, siteUrl).href;
  const organization = { "@type": "Organization", "@id": url("/#organization"), name: "xMatrix", url: url("/"),
    logo: url("/brand/xmatrix-icon.png"), sameAs: [REPOSITORY_URL, X_ACCOUNT_URL] };
  return JSON.stringify({ "@context": "https://schema.org", "@graph": [
    organization,
    { "@type": "WebSite", "@id": url("/#website"), name: "xMatrix", alternateName: "xmatrix.sh", url: url("/"),
      publisher: { "@id": organization["@id"] } },
    { "@type": "WebPage", "@id": url(`${home}#webpage`), name: meta.title, url: url(home), inLanguage: lang,
      description: meta.description, primaryImageOfPage: url(shareImage.url), isPartOf: { "@id": url("/#website") } },
  ] }).replace(/</gu, "\\u003c");
}

/** The homepage in one language; every locale shares one layout and differs only in copy. */
export function Home({ locale }: { locale: Locale }) {
  return (
    <div className="site-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: homeStructuredData(locale) }} />
      <Navbar locale={locale} />
      <Hero locale={locale} />
      <main>
        <LivePage locale={locale} />
        <Conversations locale={locale} />
        <Agents locale={locale} />
        <Why locale={locale} />
        <Connectors locale={locale} />
        <Pricing locale={locale} />
        <Faq locale={locale} />
        <Closing locale={locale} />
      </main>
      <Footer locale={locale} basePath="/" />
    </div>
  );
}

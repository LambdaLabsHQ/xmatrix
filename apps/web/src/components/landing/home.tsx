import type { Metadata } from "next";
import { Navbar } from "@/components/shared/navbar";
import { Hero } from "@/components/landing/hero";
import { QuickStart } from "@/components/landing/quick-start";
import { AgentStrip } from "@/components/landing/agent-strip";
import { LivePage } from "@/components/landing/live-page";
import { Why } from "@/components/landing/why";
import { Faq } from "@/components/landing/faq";
import { Connectors } from "@/components/landing/connectors";
import { Pricing } from "@/components/landing/pricing";
import { Footer, X_ACCOUNT_URL } from "@/components/landing/footer";
import { DocumentLanguage } from "@/components/landing/document-language";
import { landingCopy, type Locale } from "@/lib/landing-copy";
import { shareImage, siteUrl } from "@/lib/site-url";
import { REPOSITORY_URL } from "@/lib/star-prompt";

/** Each homepage names itself canonical and points search engines at the other language. */
export function homeMetadata(locale: Locale): Metadata {
  const { home, lang, meta } = landingCopy[locale];
  return {
    title: meta.title,
    description: meta.description,
    alternates: {
      canonical: home,
      languages: Object.fromEntries([
        ...Object.values(landingCopy).map((copy) => [copy.lang, copy.home]),
        ["x-default", landingCopy.en.home],
      ]),
    },
    openGraph: {
      title: meta.title,
      description: meta.shareDescription,
      url: home,
      type: "website",
      locale: lang.replace("-", "_"),
      images: [shareImage],
    },
  };
}

/**
 * Who and what the site is, for search engines: the site's name (so results
 * read "xMatrix", not another X-matrix), its maker and the app itself.
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
    { "@type": "SoftwareApplication", name: "xMatrix", url: url(home), inLanguage: lang, description: meta.description,
      image: url(shareImage.url), applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Windows, Linux, Android, Web",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, publisher: { "@id": organization["@id"] } },
  ] }).replace(/</gu, "\\u003c");
}

/** The homepage in one language; `/` and `/zh` differ only in their copy. */
export function Home({ locale }: { locale: Locale }) {
  return (
    <div className="site-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: homeStructuredData(locale) }} />
      <DocumentLanguage lang={landingCopy[locale].lang} />
      <Navbar locale={locale} />
      <Hero locale={locale} />
      <AgentStrip locale={locale} />
      <LivePage locale={locale} />
      <QuickStart locale={locale} />
      <Why locale={locale} />
      <Connectors locale={locale} />
      <Pricing locale={locale} />
      <Faq locale={locale} />
      <Footer locale={locale} />
    </div>
  );
}

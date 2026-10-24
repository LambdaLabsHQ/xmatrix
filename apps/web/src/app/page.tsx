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
import { shareImage, siteUrl } from "@/lib/site-url";
import { REPOSITORY_URL } from "@/lib/star-prompt";

const description = "Talk with your team and coding agents like Claude Code, Codex, Cursor and Gemini. Turn conversations into living pages of decisions, open work and next steps, then keep them current together.";

export const metadata: Metadata = {
  title: "xMatrix — Living pages maintained by your AI agents",
  description,
  alternates: { canonical: "/" },
  openGraph: {
    title: "xMatrix — Living pages maintained by your AI agents",
    description: "Talk with your team. Your AI agents keep decisions, open work and next steps current in Pages.",
    url: "/",
    type: "website",
    images: [shareImage],
  },
};

/**
 * Who and what the site is, for search engines: the site's name (so results
 * read "xMatrix", not another X-matrix), its maker and the app itself.
 */
function homeStructuredData(): string {
  const url = (href: string) => new URL(href, siteUrl).href;
  const organization = { "@type": "Organization", "@id": url("/#organization"), name: "xMatrix", url: url("/"),
    logo: url("/brand/xmatrix-icon.png"), sameAs: [REPOSITORY_URL, X_ACCOUNT_URL] };
  return JSON.stringify({ "@context": "https://schema.org", "@graph": [
    organization,
    { "@type": "WebSite", "@id": url("/#website"), name: "xMatrix", alternateName: "xmatrix.sh", url: url("/"),
      inLanguage: "en", publisher: { "@id": organization["@id"] } },
    { "@type": "SoftwareApplication", name: "xMatrix", url: url("/"), description, image: url(shareImage.url),
      applicationCategory: "DeveloperApplication", operatingSystem: "macOS, Windows, Linux, Android, Web",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, publisher: { "@id": organization["@id"] } },
  ] }).replace(/</gu, "\\u003c");
}

export default function Home() {
  return (
    <div className="site-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: homeStructuredData() }} />
      <Navbar />
      <Hero />
      <AgentStrip />
      <LivePage />
      <QuickStart />
      <Why />
      <Connectors />
      <Pricing />
      <Faq />
      <Footer />
    </div>
  );
}

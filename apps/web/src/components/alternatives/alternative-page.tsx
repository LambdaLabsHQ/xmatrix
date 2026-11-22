import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, Plus } from "lucide-react";

import {
  absoluteSiteHref,
  alternativesBreadcrumbGraph,
  AlternativesCtaBand,
  serializeJsonLd,
} from "@/components/alternatives/alternatives-shared";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { relatedAlternatives, type AlternativePage } from "@/lib/alternatives";
import { shareImage } from "@/lib/site-url";

function alternativeStructuredData(page: AlternativePage): string {
  return serializeJsonLd([
    {
      "@type": "WebPage",
      name: page.metaTitle,
      description: page.metaDescription,
      url: absoluteSiteHref(page.href),
      inLanguage: "en",
      publisher: { "@type": "Organization", name: "xMatrix", url: absoluteSiteHref("/") },
      primaryImageOfPage: absoluteSiteHref(shareImage.url),
    },
    alternativesBreadcrumbGraph([
      { name: "xMatrix", href: "/" },
      { name: "Alternatives", href: "/alternatives" },
      { name: `${page.name} Alternative`, href: page.href },
    ]),
    {
      "@type": "FAQPage",
      mainEntity: page.faqs.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer,
        },
      })),
    },
  ]);
}

export function AlternativeDetailPage({ page }: { page: AlternativePage }) {
  const siblings = relatedAlternatives(page);

  return (
    <div className="site-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: alternativeStructuredData(page) }}
      />
      <Navbar />
      <main>
        <section className="mx-auto max-w-5xl px-6 pt-32 pb-14">
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Link href="/" className="transition-colors hover:text-foreground">
              xMatrix
            </Link>
            <span aria-hidden>/</span>
            <Link href="/alternatives" className="transition-colors hover:text-foreground">
              Alternatives
            </Link>
            <span aria-hidden>/</span>
            <span className="text-foreground">{page.name}</span>
          </nav>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <p className="x-eyebrow uppercase">
              {page.eyebrow}
              {page.alsoKnownAs ? ` · ${page.alsoKnownAs}` : ""}
            </p>
            <span className="text-xs text-muted-foreground">Verified {page.verifiedDate}</span>
          </div>

          <h1 className="site-display mt-4 max-w-4xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            {page.headline}
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-muted-foreground">{page.lead}</p>

          {page.statusNote && (
            <div className="site-paper-sheet mt-6 border-[var(--site-wood-deep)]/40 p-4 text-sm leading-6 font-semibold text-foreground">
              {page.statusNote}
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <WoodPanel
              as={Link}
              href="/login"
              className="site-wood-pill inline-flex h-12 items-center gap-2 px-6 text-sm"
            >
              Start Free with xMatrix
              <ArrowRight className="size-4" aria-hidden />
            </WoodPanel>
            <Link
              href="/docs"
              className="inline-flex h-12 items-center rounded-full border border-[var(--site-wood-line)] px-5 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              Read the guide
            </Link>
            <Link
              href="/alternatives"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              All alternatives
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="site-display text-2xl font-semibold text-foreground sm:text-3xl">
            Why teams look for a {page.name} alternative
          </h2>
          <div className="mt-8 grid gap-5">
            {page.painPoints.map((point, index) => (
              <article key={point.title} className="site-paper-sheet p-6 sm:p-8">
                <p className="text-xs font-bold tracking-wider text-[var(--site-wood-deep)] uppercase">
                  0{index + 1} · {page.name} gap
                </p>
                <h3 className="mt-2 text-xl font-semibold text-foreground">{point.title}</h3>
                <p className="mt-3 text-sm leading-7 text-muted-foreground sm:text-base">{point.problem}</p>
                <div className="mt-5 border-t border-[var(--site-wood-line)] pt-4">
                  <p className="text-xs font-bold tracking-wider text-foreground uppercase">How xMatrix handles it</p>
                  <p className="mt-1.5 text-sm leading-7 text-foreground/90 sm:text-base">{point.xmatrixAnswer}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="site-display text-2xl font-semibold text-foreground sm:text-3xl">
            xMatrix vs. {page.name} at a glance
          </h2>
          <div className="site-paper-sheet mt-6 overflow-x-auto">
            <table className="w-full min-w-[38rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--site-wood-line)]">
                  <th className="w-1/4 px-5 py-4 font-semibold text-muted-foreground">Dimension</th>
                  <th className="w-[37.5%] px-5 py-4 font-semibold text-foreground">xMatrix</th>
                  <th className="w-[37.5%] px-5 py-4 font-semibold text-muted-foreground">{page.name}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--site-wood-line)]">
                {page.comparisonRows.map((row) => (
                  <tr key={row.dimension} className="align-top">
                    <th scope="row" className="px-5 py-4 font-semibold text-foreground">
                      {row.dimension}
                    </th>
                    <td className="px-5 py-4 leading-6 text-foreground">{row.xmatrix}</td>
                    <td className="px-5 py-4 leading-6 text-muted-foreground">{row.competitor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="site-display text-2xl font-semibold text-foreground sm:text-3xl">
            When to stay with {page.name} vs. switch to xMatrix
          </h2>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div className="site-paper-sheet p-6">
              <h3 className="text-base font-semibold text-foreground">Stay with {page.name} if…</h3>
              <ul className="mt-4 space-y-3">
                {page.stayWhen.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm leading-6 text-muted-foreground">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="site-paper-sheet p-6">
              <h3 className="text-base font-semibold text-foreground">Switch to xMatrix if…</h3>
              <ul className="mt-4 space-y-3">
                {page.switchWhen.map((item) => (
                  <li key={item} className="flex gap-2.5 text-sm leading-6 text-foreground/90">
                    <Check className="mt-1 size-4 shrink-0 text-[var(--site-wood-deep)]" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="site-display text-2xl font-semibold text-foreground sm:text-3xl">
            Moving from {page.name} to xMatrix
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {page.migrationSteps.map((step, index) => (
              <div key={step.title} className="site-paper-sheet p-6">
                <p className="text-xs font-bold tracking-wider text-[var(--site-wood-deep)] uppercase">
                  Step {index + 1}
                </p>
                <h3 className="mt-2 text-base font-semibold text-foreground">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.detail}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="site-display text-2xl font-semibold text-foreground sm:text-3xl">
            Frequently asked questions
          </h2>
          <div className="mt-8 max-w-3xl divide-y divide-foreground/10 border-y border-foreground/10">
            {page.faqs.map((item) => (
              <details key={item.question} className="site-faq group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-base font-semibold text-foreground">
                  {item.question}
                  <Plus
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45"
                    aria-hidden
                  />
                </summary>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <AlternativesCtaBand
          sectionClassName="mx-auto max-w-5xl px-6 pt-6 pb-14"
          heading="Try xMatrix free with your existing coding agents."
          body="Keep your Claude Code, Codex, Cursor, Gemini, or Antigravity subscriptions. Up to 3 people and unlimited agents free; Pro is $10/human seat/month ($8/mo billed annually)."
        />

        {siblings.length > 0 && (
          <section className="mx-auto max-w-5xl px-6 pt-4 pb-24">
            <h2 className="text-sm font-bold tracking-wider text-muted-foreground uppercase">
              Related comparisons
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {siblings.map((sibling) => (
                <Link
                  key={sibling.slug}
                  href={sibling.href}
                  className="site-paper-sheet group flex items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:border-foreground/30"
                >
                  <span>{sibling.name}</span>
                  <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import {
  absoluteSiteHref,
  alternativesBreadcrumbGraph,
  AlternativesCtaBand,
  serializeJsonLd,
} from "@/components/alternatives/alternatives-shared";
import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { alternativeCategories, alternativePages, alternativePagesByCategory } from "@/lib/alternatives";

function alternativesIndexStructuredData(): string {
  return serializeJsonLd([
    {
      "@type": "CollectionPage",
      name: "xMatrix Alternatives & Competitor Comparisons",
      description:
        "Compare xMatrix with Raft, Lody, Multica, Paradev (Superset), Conductor, Orca, LobeHub, Cumora, T3 Code, herdr, Seedmux, Claude Code Desktop, Linear, Notion, Slack Code, Nowledge Mem, EverOS, YouMind, and Google Jules.",
      url: absoluteSiteHref("/alternatives"),
      inLanguage: "en",
    },
    {
      "@type": "ItemList",
      itemListElement: alternativePages.map((page, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: `${page.name} Alternative`,
        url: absoluteSiteHref(page.href),
      })),
    },
    alternativesBreadcrumbGraph([
      { name: "xMatrix", href: "/" },
      { name: "Alternatives", href: "/alternatives" },
    ]),
  ]);
}

export function AlternativesIndex() {
  const urgentMigrations = alternativePages.filter((page) => Boolean(page.statusNote));

  return (
    <div className="site-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: alternativesIndexStructuredData() }}
      />
      <Navbar />
      <main>
        <section className="mx-auto max-w-6xl px-6 pt-32 pb-16">
          <p className="x-eyebrow uppercase">Comparisons · Verified November 22, 2026</p>
          <h1 className="site-display mt-4 max-w-4xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Compare xMatrix with every major coding-agent tool.
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-muted-foreground">
            Every comparison below focuses on verifiable architectural tradeoffs, current pricing, and real community pain
            points—including where another tool is still the better choice and when living Pages, multiplayer Channels,
            cross-provider quota handoff, and governed connectors win.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <WoodPanel
              as={Link}
              href="/login"
              className="site-wood-pill inline-flex h-12 items-center gap-2 px-6 text-sm"
            >
              Start Free
              <ArrowRight className="size-4" aria-hidden />
            </WoodPanel>
            <Link
              href="/docs"
              className="inline-flex h-12 items-center rounded-full border border-[var(--site-wood-line)] px-5 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              Read the guide
            </Link>
          </div>

          {urgentMigrations.length > 0 && (
            <div className="mt-12 grid gap-4 md:grid-cols-2">
              {urgentMigrations.map((page) => (
                <Link
                  key={page.slug}
                  href={page.href}
                  className="site-paper-sheet group flex flex-col justify-between gap-3 p-5 transition-colors hover:border-foreground/30"
                >
                  <div>
                    <p className="text-xs font-bold tracking-wider text-[var(--site-wood-deep)] uppercase">
                      Migration notice · {page.name}
                    </p>
                    <p className="mt-2 text-sm leading-6 font-semibold text-foreground">{page.statusNote}</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    See {page.name} migration guide
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {alternativeCategories.map((category) => {
          const pages = alternativePagesByCategory(category.id);
          return (
            <section key={category.id} className="mx-auto max-w-6xl px-6 py-12">
              <div className="max-w-3xl">
                <h2 className="site-display text-2xl font-semibold text-foreground sm:text-3xl">
                  {category.label}
                </h2>
                <p className="mt-3 text-base leading-7 text-muted-foreground">{category.description}</p>
              </div>

              <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {pages.map((page) => (
                  <Link
                    key={page.slug}
                    href={page.href}
                    className="site-paper-sheet group flex flex-col justify-between gap-4 p-6 transition-colors hover:border-foreground/30"
                  >
                    <div>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="text-lg font-semibold text-foreground">
                          {page.name} Alternative
                        </h3>
                        {page.alsoKnownAs && (
                          <span className="text-xs text-muted-foreground">({page.alsoKnownAs})</span>
                        )}
                      </div>
                      {page.statusNote && (
                        <p className="mt-2 text-xs font-semibold text-[var(--site-wood-deep)]">
                          {page.statusNote}
                        </p>
                      )}
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">{page.indexSummary}</p>
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      Read comparison
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}

        <AlternativesCtaBand
          sectionClassName="mx-auto max-w-6xl px-6 pt-8 pb-24"
          heading="Living pages maintained by the coding agents you already pay for."
          body="Free for up to 3 people with unlimited agents. Pro is $10/human seat/month ($8/mo billed annually) with 5,000 pooled agent credits per seat and 20+ governed app connectors."
        />
      </main>
      <Footer />
    </div>
  );
}

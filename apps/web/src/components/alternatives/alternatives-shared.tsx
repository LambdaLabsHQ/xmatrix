import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import { siteUrl } from "@/lib/site-url";

export function absoluteSiteHref(href: string): string {
  return new URL(href, siteUrl).href;
}

export function alternativesBreadcrumbGraph(items: readonly { name: string; href: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name,
      item: absoluteSiteHref(entry.href),
    })),
  };
}

export function serializeJsonLd(graph: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": graph,
  }).replace(/</gu, "\\u003c");
}

export function AlternativesCtaBand({
  heading,
  body,
  sectionClassName,
}: {
  heading: string;
  body: string;
  sectionClassName: string;
}) {
  return (
    <section className={sectionClassName}>
      <WoodPanel className="p-8 sm:p-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <h2 className="site-display text-2xl font-semibold sm:text-3xl">{heading}</h2>
            <p className="mt-3 text-sm leading-6">{body}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidGlassPill
              as={Link}
              href="/login"
              className="inline-flex h-11 items-center gap-2 px-5 text-sm font-semibold"
            >
              Start Free
              <ArrowRight className="size-4" aria-hidden />
            </LiquidGlassPill>
            <LiquidGlassPill
              as={Link}
              href="/download"
              className="inline-flex h-11 items-center px-5 text-sm font-semibold"
            >
              Download
            </LiquidGlassPill>
          </div>
        </div>
      </WoodPanel>
    </section>
  );
}

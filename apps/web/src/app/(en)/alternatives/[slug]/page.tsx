import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AlternativeDetailPage } from "@/components/alternatives/alternative-page";
import { alternativePageMetadata, alternativePages, findAlternativePageByRouteSlug } from "@/lib/alternatives";

/**
 * Internal render target for flat root-level `/<competitor>-alternatives` URLs
 * rewritten by `src/middleware.ts`. Direct requests to `/alternatives/*` are
 * rejected with 404 by middleware so only the canonical `/<slug>-alternatives`
 * addresses are reachable.
 */
type Params = { params: Promise<{ slug: string }> };

/** Prerendered at build, so a crawler or visitor never waits for a cold render. */
export function generateStaticParams() {
  return alternativePages.map((page) => ({ slug: page.routeSlug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return alternativePageMetadata((await params).slug, "en");
}

export default async function InternalAlternativeRoutePage({ params }: Params) {
  const page = findAlternativePageByRouteSlug((await params).slug, "en");
  if (!page) notFound();
  return <AlternativeDetailPage page={page} locale="en" />;
}

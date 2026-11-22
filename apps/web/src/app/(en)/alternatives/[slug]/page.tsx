import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AlternativeDetailPage } from "@/components/alternatives/alternative-page";
import { alternativePageMetadata, findAlternativePageByRouteSlug } from "@/lib/alternatives";

/**
 * Internal render target for flat root-level `/<competitor>-alternatives` URLs
 * rewritten by `src/middleware.ts`. Direct requests to `/alternatives/*` are
 * rejected with 404 by middleware so only the canonical `/<slug>-alternatives`
 * addresses are reachable.
 */
type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return alternativePageMetadata((await params).slug, "en");
}

export default async function InternalAlternativeRoutePage({ params }: Params) {
  const page = findAlternativePageByRouteSlug((await params).slug, "en");
  if (!page) notFound();
  return <AlternativeDetailPage page={page} locale="en" />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AlternativeDetailPage } from "@/components/alternatives/alternative-page";
import { findAlternativePageByRouteSlug } from "@/lib/alternatives";
import { shareImage } from "@/lib/site-url";

/**
 * Internal render target for flat root-level `/<competitor>-alternatives` URLs
 * rewritten by `src/middleware.ts`. Direct requests to `/alternatives/*` are
 * rejected with 404 by middleware so only the canonical `/<slug>-alternatives`
 * addresses are reachable.
 */
type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = findAlternativePageByRouteSlug((await params).slug);
  if (!page) return {};
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    alternates: { canonical: page.href },
    openGraph: {
      title: page.metaTitle,
      description: page.metaDescription,
      url: page.href,
      siteName: "xMatrix",
      type: "website",
      images: [shareImage],
    },
    twitter: {
      card: "summary_large_image",
      title: page.metaTitle,
      description: page.metaDescription,
      images: [shareImage],
    },
  };
}

export default async function InternalAlternativeRoutePage({ params }: Params) {
  const page = findAlternativePageByRouteSlug((await params).slug);
  if (!page) notFound();
  return <AlternativeDetailPage page={page} />;
}

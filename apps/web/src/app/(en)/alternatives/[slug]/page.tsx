import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AlternativeDetailPage } from "@/components/alternatives/alternative-page";
import { findAlternativePage } from "@/lib/alternatives";
import { shareImage } from "@/lib/site-url";

/**
 * Competitor alternative landing pages: /alternatives/raft, /alternatives/t3-code, …
 * Rendered per request: the deployed Worker keeps no prerendered pages, so a
 * route limited to static params would answer 404 for every one of them.
 */
type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = findAlternativePage((await params).slug);
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

export default async function AlternativeSlugPage({ params }: Params) {
  const page = findAlternativePage((await params).slug);
  if (!page) notFound();
  return <AlternativeDetailPage page={page} />;
}

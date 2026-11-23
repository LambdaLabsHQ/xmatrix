import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GuideDocument } from "@/components/docs/guide-document";
import { findGuidePage, guidePageMetadata, guidePages } from "@/lib/docs/guide";

/**
 * The user guide, one address per file of docs/guide: /docs, /docs/syntax, …
 * Each page is prerendered at build and served from the Worker's read-only page
 * cache (open-next.config.ts); any other address still renders per request.
 */
type Params = { params: Promise<{ slug?: string[] }> };

export function generateStaticParams() {
  return guidePages.map((page) => ({ slug: page.file === "index" ? [] : [page.file] }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return guidePageMetadata((await params).slug, "en");
}

export default async function GuidePageView({ params }: Params) {
  const page = findGuidePage((await params).slug, "en");
  if (!page) notFound();
  return <GuideDocument page={page} locale="en" />;
}

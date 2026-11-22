import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GuideDocument } from "@/components/docs/guide-document";
import { findGuidePage, guidePageMetadata } from "@/lib/docs/guide";

/**
 * The user guide, one address per file of docs/guide: /docs, /docs/syntax, …
 * Rendered per request: the deployed Worker keeps no prerendered pages, so a
 * route limited to its static params answered 404 for every one of them.
 */
type Params = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return guidePageMetadata((await params).slug, "en");
}

export default async function GuidePageView({ params }: Params) {
  const page = findGuidePage((await params).slug, "en");
  if (!page) notFound();
  return <GuideDocument page={page} locale="en" />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { GuideDocument } from "@/components/docs/guide-document";
import { guidePages } from "@/lib/docs/guide";

/** The user guide, one address per file of docs/guide: /docs, /docs/syntax, … */
type Params = { params: Promise<{ slug?: string[] }> };

function guidePage(slug: string[] = []) {
  if (slug.length > 1) return undefined;
  return guidePages.find((page) => page.file === (slug[0] ?? "index") && (slug.length === 0 || page.file !== "index"));
}

export const dynamicParams = false;

export function generateStaticParams() {
  return guidePages.map((page) => ({ slug: page.file === "index" ? [] : [page.file] }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = guidePage((await params).slug);
  if (!page) return {};
  return {
    title: page.file === "index" ? "xMatrix Docs" : `${page.title} · xMatrix Docs`,
    description: page.description,
    alternates: { canonical: page.href },
  };
}

export default async function GuidePageView({ params }: Params) {
  const page = guidePage((await params).slug);
  if (!page) notFound();
  return <GuideDocument page={page} />;
}

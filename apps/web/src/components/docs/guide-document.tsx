import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown from "react-markdown";
import { pageHeadingSlug } from "@xmatrix/protocol";

import { Footer } from "@/components/landing/footer";
import { Navbar } from "@/components/shared/navbar";
import { guideLinkHref, guidePages, type GuidePage } from "@/lib/docs/guide";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";
import { shareImage, siteUrl } from "@/lib/site-url";
import { REPOSITORY_URL } from "@/lib/star-prompt";

function plainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return plainText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** A heading carries the id GitHub gives it, so `#section` links work in both places. */
function heading(Tag: "h2" | "h3") {
  return function GuideHeading({ children }: ComponentPropsWithoutRef<"h2">) {
    return <Tag id={pageHeadingSlug(plainText(children))}>{children}</Tag>;
  };
}

function GuideLink({ href = "", children }: ComponentPropsWithoutRef<"a">) {
  const target = guideLinkHref(href);
  return target.startsWith("/") || target.startsWith("#")
    ? <Link href={target}>{children}</Link>
    : <a href={target} rel="noreferrer">{children}</a>;
}

const components = {
  h2: heading("h2"),
  h3: heading("h3"),
  a: GuideLink,
  // A wide table scrolls inside its own frame instead of widening the page.
  table: ({ children }: ComponentPropsWithoutRef<"table">) => <div className="docs-table"><table>{children}</table></div>,
};

/** What the page is, for search engines: an article of the guide, and where it sits in the site. */
function guideStructuredData(page: GuidePage): string {
  const url = (href: string) => new URL(href, siteUrl).href;
  const publisher = { "@type": "Organization", name: "xMatrix", url: url("/") };
  return JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "TechArticle", headline: page.title, description: page.description, url: url(page.href),
      mainEntityOfPage: url(page.href), inLanguage: "en", author: publisher, publisher,
      image: url(shareImage.url) },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "xMatrix", item: url("/") },
      { "@type": "ListItem", position: 2, name: "Docs", item: url("/docs") },
      ...(page.file === "index" ? [] : [{ "@type": "ListItem", position: 3, name: page.title, item: url(page.href) }]),
    ] },
  ] }).replace(/</gu, "\\u003c");
}

/**
 * One page of the user guide. The text is drawn with the styles an xMatrix
 * page uses (`page-document`), so the guide reads like a page in the app.
 */
export function GuideDocument({ page }: { page: GuidePage }) {
  const position = guidePages.indexOf(page);
  const previous = guidePages[position - 1];
  const next = guidePages[position + 1];
  return (
    <div className="site-page docs-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: guideStructuredData(page) }} />
      <Navbar />
      <main className="docs-shell">
        <nav className="docs-nav" aria-label="Guide">
          <p className="docs-label">Guide</p>
          {guidePages.map((entry) => (
            <Link key={entry.file} href={entry.href} aria-current={entry === page ? "page" : undefined}>
              {entry.title}
            </Link>
          ))}
        </nav>
        <div className="docs-main">
          <article className="page-document docs-article" data-editable="false">
            <h1>{page.title}</h1>
            <Markdown remarkPlugins={markdownRemarkPlugins} components={components}>{page.body}</Markdown>
          </article>
          <footer className="docs-foot">
            <div className="docs-pager">
              {previous && <Link href={previous.href} rel="prev"><span>Previous</span>{previous.title}</Link>}
              {next && <Link href={next.href} rel="next"><span>Next</span>{next.title}</Link>}
            </div>
            <a className="docs-source" href={`${REPOSITORY_URL}/blob/main/docs/guide/${page.file}.md`} rel="noreferrer">
              View this page on GitHub
            </a>
          </footer>
        </div>
        {page.sections.length > 0 && (
          <nav className="docs-toc" aria-label="On this page">
            <p className="docs-label">On this page</p>
            {page.sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
          </nav>
        )}
      </main>
      <Footer />
    </div>
  );
}

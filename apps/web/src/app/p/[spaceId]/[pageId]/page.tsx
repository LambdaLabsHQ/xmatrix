import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";
import { loadPublicPage as load } from "@/lib/pages/public-page";
import { PublicPageLive } from "./public-page-live";

/**
 * A published page for anyone, signed in or not:
 * rendered on the server so it is indexable, and refreshed while someone reads it.
 */
type Params = { params: Promise<{ spaceId: string; pageId: string }> };
/** The first paragraph of prose, for search results and link previews. */
function summary(body: string): string {
  const paragraph = body.split(/\n{2,}/u).map((part) => part.trim())
    .find((part) => part && !part.startsWith("#") && !part.startsWith("|") && !part.startsWith("```"));
  return (paragraph ?? "").replace(/[*_`>[\]]/gu, "").slice(0, 200);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { spaceId, pageId } = await params;
  const loaded = await load(spaceId, pageId);
  if (!loaded) return { title: "Page not found · xMatrix" };
  const title = `${loaded.page.title} · ${loaded.page.spaceName}`;
  const description = summary(loaded.page.body);
  return { title, description, openGraph: { title, description, type: "article" } };
}

export default async function PublicPageView({ params }: Params) {
  const { spaceId, pageId } = await params;
  const loaded = await load(spaceId, pageId);
  if (!loaded) notFound();
  const { page, present } = loaded;
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-10" data-testid="public-page">
      <p className="mb-6 text-sm text-muted-foreground">{page.spaceName}</p>
      <article className="prose max-w-none">
        <Markdown remarkPlugins={markdownRemarkPlugins}>{page.body}</Markdown>
      </article>
      {page.children.length > 0 && (
        <nav className="mt-10 border-t pt-4" aria-label="Pages below">
          <ul className="space-y-1 text-sm">
            {page.children.map((child) => (
              <li key={child.pageId}>
                <Link className="underline" href={`/p/${encodeURIComponent(spaceId)}/${encodeURIComponent(child.pageId)}`}>
                  {child.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <footer className="mt-12 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4 text-xs text-muted-foreground">
        <PublicPageLive present={present} />
        <span>
          Updated {new Date(page.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
          {page.authors.length > 0 && ` by ${page.authors.map((author) => author.label).join(", ")}`}
        </span>
        {page.openToJoin && (
          <Link className="font-semibold underline" href={`/spaces/join/${encodeURIComponent(spaceId)}`}>
            Take part in this project
          </Link>
        )}
        <a className="ml-auto underline" href="https://xmatrix.sh">Live · maintained by agents on xMatrix</a>
      </footer>
    </main>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import {
  AUTOMATION_REFERENCE_SCHEME, agentFaceUrl, gitHubFileUrl, pageMediaFile, parseGitHubFileReference, parsePageMedia,
  withRoute,
} from "@xmatrix/protocol";
import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { isShortCell, SHORT_CELL_CLASS } from "@/components/pages/page-table-cells";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
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

/**
 * A file the page embeds links to GitHub here: a public reader is never shown a repository's contents.
 * An image or video pasted into the page is read from the Hub as the public page's own.
 */
function publicPageUrl(spaceId: string, pageId: string) {
  return (url: string): string => {
    const media = parsePageMedia(url);
    if (media) {
      return withRoute(getXMatrixHubUrl(), `/api/public/spaces/${encodeURIComponent(spaceId)}/pages/${
        encodeURIComponent(pageId)}/media/${media.file}`);
    }
    // A reminder the page keeps stays its name; a public reader sees no schedule (page-automation-chips.ts).
    if (url.startsWith(AUTOMATION_REFERENCE_SCHEME)) return url;
    const reference = parseGitHubFileReference(url);
    return reference ? gitHubFileUrl(reference) : defaultUrlTransform(url);
  };
}

type HastNode = { type: string; value?: string; children?: HastNode[] };
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  return node.type === "text" ? node.value ?? "" : (node.children ?? []).map(hastText).join("");
}
type CellProps = React.ComponentProps<"td"> & ExtraProps;
/** As the live editor draws a cell: a date or a time keeps to one line (page-table-cells.ts). */
const cell = (Tag: "td" | "th") => function Cell({ node, className, ...props }: CellProps) {
  const short = isShortCell(hastText(node as HastNode | undefined));
  return <Tag {...props} className={[className, short ? SHORT_CELL_CLASS : ""].filter(Boolean).join(" ") || undefined} />;
};

/**
 * The page drawn with the live editor's styles (page-document.css): a pasted video plays where the page shows it,
 * a table scrolls itself when it is too wide, and an Automation's reference reads as its name.
 */
const publicPageComponents: Components = {
  img: ({ src, alt, title }) => typeof src === "string" && pageMediaFile(src.slice(src.lastIndexOf("/") + 1))?.video
    ? <video src={src} title={alt} controls preload="metadata" playsInline className="max-w-full rounded-md" />
    // eslint-disable-next-line @next/next/no-img-element -- markdown images are arbitrary, not next/image assets.
    : <img src={src} alt={alt ?? ""} title={title} />,
  a: ({ href, children, node: _node, ...props }) => href?.startsWith(AUTOMATION_REFERENCE_SCHEME)
    ? <span className="page-automation-chip" data-state="public">{children}</span>
    : <a href={href} {...props}>{children}</a>,
  table: ({ node: _node, ...props }) => <div className="page-table-scroll"><table {...props} /></div>,
  td: cell("td"),
  th: cell("th"),
};

const PAGE_UPDATED = new Intl.DateTimeFormat("en", {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
});

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
  const writers = page.authors.map((author) => author.label);
  return (
    <div className="site-page public-page" data-testid="public-page">
      <header className="public-page-bar">
        <WoodPanel className="public-page-sign">
          <BrandMark href="https://xmatrix.sh" showWordmark={false} iconClassName="size-6 rounded-[7px]" />
          <span className="public-page-space">{page.spaceName}</span>
        </WoodPanel>
        <PublicPageLive present={present} />
      </header>
      <main className="public-page-sheet">
        <article className="page-document public-page-document">
          <Markdown remarkPlugins={markdownRemarkPlugins} urlTransform={publicPageUrl(spaceId, pageId)}
            components={publicPageComponents}>{page.body}</Markdown>
        </article>
        {page.children.length > 0 && (
          <nav className="public-page-children" aria-label="Pages below">
            {page.children.map((child) => (
              <Link key={child.pageId} href={`/p/${encodeURIComponent(spaceId)}/${encodeURIComponent(child.pageId)}`}>
                {child.title}
              </Link>
            ))}
          </nav>
        )}
        <footer className="public-page-footer">
          <span className="public-page-byline">
            {page.authors.map((author) => [author.label, author.kind === "agent" ? agentFaceUrl(author.label) : undefined])
              .filter((face): face is [string, string] => Boolean(face[1])).map(([label, url]) => (
                // eslint-disable-next-line @next/next/no-img-element -- an Agent's face is a small static asset.
                <img key={label} src={url} alt="" aria-hidden className="public-page-face" />
              ))}
            <span>
              Updated {PAGE_UPDATED.format(new Date(page.updatedAt))} UTC
              {writers.length > 0 && ` by ${writers.join(", ")}`}
            </span>
          </span>
          {page.openToJoin && (
            <Link className="public-page-join" href={`/spaces/join/${encodeURIComponent(spaceId)}`}>
              Take part in this project
            </Link>
          )}
          <a className="public-page-made" href="https://xmatrix.sh">Live · maintained by agents on xMatrix</a>
        </footer>
      </main>
    </div>
  );
}

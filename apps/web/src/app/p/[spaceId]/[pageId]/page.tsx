import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import {
  AUTOMATION_REFERENCE_SCHEME, gitHubFileUrl, pageMediaFile, parseGitHubFileReference, parsePageMedia,
  withRoute,
} from "@xmatrix/protocol";
import { BrandMark } from "@/components/shared/brand-mark";
import { WoodPanel } from "@/components/ui/material-surfaces";
import { isShortCell, SHORT_CELL_CLASS } from "@/components/pages/page-table-cells";
import { getXMatrixHubUrl } from "@/lib/xmatrix";
import { markdownRemarkPlugins } from "@/lib/markdown-plugins";
import { loadPublicPage as load } from "@/lib/pages/public-page";
import { landingCopy } from "@/lib/landing-copy";
import { PublicPageFaces, PublicPageRefresh } from "./public-page-live";
import { PublicPageOutline } from "./public-page-outline";

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
/** react-markdown hands each component its syntax node, which is not an attribute of the element. */
function withoutNode<T extends ExtraProps>({ node, ...props }: T): Omit<T, "node"> {
  void node;
  return props;
}
type CellProps = React.ComponentProps<"td"> & ExtraProps;
/** As the live editor draws a cell: a date or a time keeps to one line (page-table-cells.ts). */
const cell = (Tag: "td" | "th") => function Cell({ node, className, ...props }: CellProps) {
  const short = isShortCell(hastText(node as HastNode | undefined));
  return <Tag {...props} className={[className, short ? SHORT_CELL_CLASS : ""].filter(Boolean).join(" ") || undefined} />;
};

const BYLINE = {
  en: { editing: (names: string) => `${names} ${names.includes(",") ? "are" : "is"} editing now`,
    kept: (names: string) => `Kept current by ${names}`, updated: (ago: string) => `updated ${ago}`, rtf: "en" },
  zh: { editing: (names: string) => `${names} 正在编辑`, kept: (names: string) => `${names} 维护`,
    updated: (ago: string) => `${ago}更新`, rtf: "zh-CN" },
} as const;

function ago(iso: string, locale: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3600],
    ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, "minute");
}

/**
 * The page drawn with the live editor's styles (page-document.css): a pasted video plays where the page shows it,
 * a table scrolls itself when it is too wide, and an Automation's reference reads as its name.
 */
const publicPageComponents: Components = {
  img: ({ src, alt, title }) => typeof src === "string" && pageMediaFile(src.slice(src.lastIndexOf("/") + 1))?.video
    ? <video src={src} title={alt} controls preload="metadata" playsInline className="max-w-full rounded-md" />
    // eslint-disable-next-line @next/next/no-img-element -- markdown images are arbitrary, not next/image assets.
    : <img src={src} alt={alt ?? ""} title={title} />,
  a: ({ href, children, ...props }) => href?.startsWith(AUTOMATION_REFERENCE_SCHEME)
    ? <span className="page-automation-chip" data-state="public">{children}</span>
    : <a href={href} {...withoutNode(props)}>{children}</a>,
  table: (props) => <div className="page-table-scroll"><table {...withoutNode(props)} /></div>,
  td: cell("td"),
  th: cell("th"),
};

/** A page opens with its title line; the rest is its body. */
function splitTitle(body: string, fallback: string): { title: string; rest: string } {
  const match = /^\s*# (.+)\n?/u.exec(body);
  return match ? { title: match[1].trim(), rest: body.slice(match[0].length) } : { title: fallback, rest: body };
}

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
  const locale = /[\u3400-\u9fff]/u.test(page.title + page.body.slice(0, 400)) ? "zh" : "en";
  const words = BYLINE[locale];
  const { title, rest } = splitTitle(page.body, page.title);
  const working = present.filter((person) => person.activity === "editing");
  const writers = [...present.filter((person) => person.kind === "agent" || person.activity === "editing"),
    ...page.authors.filter((author) => !present.some((person) => person.name === author.label))
      .map((author) => ({ name: author.label, color: "var(--muted-foreground)", kind: author.kind, activity: null }))]
    .map((writer) => ({ ...writer, working: writer.activity === "editing" }));
  const names = (list: { name: string }[]) => list.map((writer) => writer.name).join(", ");
  const updated = new Date(page.updatedAt);
  return (
    <div className="site-page public-page" data-testid="public-page">
      <PublicPageRefresh />
      <header className="public-page-bar">
        <nav className="public-page-crumbs" aria-label="Breadcrumb">
          <BrandMark href="https://xmatrix.sh" showWordmark={false} iconClassName="size-5 rounded-[6px]" />
          <span className="public-page-crumb">{page.spaceName}</span>
          <span aria-hidden className="public-page-crumb-gap">/</span>
          <span className="public-page-crumb" aria-current="page">{page.title}</span>
        </nav>
        <WoodPanel as={Link} href="/login" className="public-page-cta">
          {landingCopy[locale].nav.startFree}
        </WoodPanel>
      </header>
      <main className="public-page-sheet">
        <h1 className="public-page-title">{title}</h1>
        {writers.length > 0 && (
          <p className="public-page-byline" data-testid="public-page-byline">
            <PublicPageFaces writers={writers} />
            <span>{working.length > 0 ? words.editing(names(working)) : words.kept(names(writers))}</span>
            <span aria-hidden>·</span>
            <time dateTime={page.updatedAt} title={`${PAGE_UPDATED.format(updated)} UTC`}>
              {words.updated(ago(page.updatedAt, words.rtf))}
            </time>
          </p>
        )}
        <article className="page-document public-page-document">
          <Markdown remarkPlugins={markdownRemarkPlugins} urlTransform={publicPageUrl(spaceId, pageId)}
            components={publicPageComponents}>{rest}</Markdown>
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
        {page.openToJoin && (
          <Link className="public-page-join" href={`/spaces/join/${encodeURIComponent(spaceId)}`}>
            Take part in this project
          </Link>
        )}
      </main>
      <PublicPageOutline />
    </div>
  );
}

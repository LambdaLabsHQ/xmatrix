"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { pageAuthorColor, pageAuthorLabel, type PageAuthor } from "@xmatrix/protocol";
import { markdownToPageDoc, pageDocDiff, type PageDocDiff } from "@xmatrix/protocol/page-document";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { statusInkClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi, type PageRevision } from "@/lib/pages/page-client";
import { sameValue } from "@/lib/same-value";
import { userErrorMessage } from "@/lib/user-facing-error";
import { cn } from "@/lib/utils";
import { renderPageDiff, renderPageDocument } from "./page-document-render";
import type { PageMediaUrl } from "./page-media";
import type { PageReferenceTargets } from "./page-reference-chips";

/**
 * A page's history (pages-live-document.md §4.2, §7): the other of the page's two states. The page is always
 * as it is now and never marks what changed; History is the same page, in the same type, at a version, with
 * what that version changed marked in the text, and its versions listed beside it. What changed since this
 * reader's last visit is its first entry, across however many versions that took.
 */

/** What History shows: everything since the reader's last visit, or what one version changed. */
type Choice = "since" | number;

const NO_REVISIONS: readonly PageRevision[] = [];
const VERSION_KIND: Record<PageRevision["kind"], string> = {
  edit: "", suggestion: "Suggestion", accepted: "Accepted suggestion", restore: "Restored", purge: "Redacted",
};

export interface PageHistoryState {
  /** The page's versions, newest first; empty until read. */
  revisions: readonly PageRevision[];
  /** The versions made since the reader's last visit, when the page moved past it. */
  news: readonly PageRevision[];
  /** The version the reader had last read when they came. */
  since: number | null;
  choice: Choice | null;
  choose: (choice: Choice) => void;
  /** The chosen version, when one version is chosen. */
  version: PageRevision | null;
  /** The chosen version's text, and what it changed; null until both sides are read. */
  shown: (PageDocDiff & { after: string }) | null;
  failed: boolean;
  /** Whether what changed is marked in the text, or the version reads as it was. */
  marked: boolean;
  mark: (marked: boolean) => void;
  /** Puts the chosen version back as the page, when it is not the page already. */
  restore: (() => Promise<void>) | null;
  error: string | null;
  /** Where the version is drawn, and the way to one of its changed sections. */
  host: RefObject<HTMLDivElement | null>;
  jump: (index: number) => void;
}

export function usePageHistory({ open, spaceId, pageId, token, headRevision, since, onRestored }: {
  open: boolean; spaceId: string | null; pageId: string | null; token: string; headRevision: number | null;
  since: number | null; onRestored: () => void;
}): PageHistoryState {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const reading = open && Boolean(spaceId && pageId) && headRevision !== null;
  const history = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "page-history", [spaceId ?? "", pageId ?? "", headRevision ?? 0]),
    enabled: reading,
    queryFn: ({ signal }) => pageApi.history(spaceId!, pageId!, token, signal).then((result) => result.revisions),
  });
  const revisions = history.data ?? NO_REVISIONS;
  // A suggestion waits beside the page; it is not a version the page has been.
  const news = useMemo(() => since === null ? NO_REVISIONS
    : revisions.filter((revision) => revision.revision > since && revision.kind !== "suggestion"), [revisions, since]);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [marked, setMarked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Each time History opens it starts from what is new.
  useEffect(() => {
    if (open) return;
    setPicked(null);
    setMarked(true);
    setError(null);
  }, [open]);
  const choice: Choice | null = picked ?? (news.length ? "since" : revisions[0]?.revision ?? null);
  const version = typeof choice === "number" ? revisions.find((revision) => revision.revision === choice) ?? null : null;
  // A version reads as what it changed from the one it was based on; before the first, the page was empty.
  const range = choice === "since" && since !== null && headRevision !== null ? { from: since, to: headRevision }
    : version ? { from: version.basedOnRevision ?? version.revision - 1, to: version.revision } : null;
  const wanted = range ? [...new Set([range.from, range.to])].filter((revision) => revision > 0) : [];
  const read = useQueries({
    queries: wanted.map((revision) => ({
      // Shared with the conversation's page cards and edit cards: a version never changes.
      queryKey: xmatrixQueryKeys.domain({ userId }, "page-document-revision", [spaceId ?? "", pageId ?? "", revision]),
      enabled: reading, staleTime: Infinity, retry: false,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        pageApi.read(spaceId!, pageId!, token, revision, signal).then((result) => result.page),
    })),
    combine: (results) => ({ bodies: results.map((result) => result.data?.body), failed: results.some((result) => result.isError) }),
  });
  const body = (revision: number) => revision > 0 ? read.bodies[wanted.indexOf(revision)] : "";
  const before = range ? body(range.from) : undefined;
  const after = range ? body(range.to) : undefined;
  const shown = useMemo(() => before === undefined || after === undefined ? null
    : { after, ...pageDocDiff(markdownToPageDoc(before), markdownToPageDoc(after)) }, [before, after]);
  const host = useRef<HTMLDivElement | null>(null);
  const restore = !version || headRevision === null || version.revision === headRevision || !spaceId || !pageId ? null
    : async () => {
      setError(null);
      try {
        await pageApi.promote(spaceId, pageId, token, version.revision, headRevision);
        onRestored();
      } catch (cause) {
        setError(userErrorMessage(cause, "Couldn't apply this revision"));
      }
    };
  return {
    revisions, news, since, choice, choose: setPicked, version, shown, failed: read.failed || history.isError, marked,
    mark: setMarked, restore, error, host,
    jump: (index) => host.current?.children[index]?.scrollIntoView({ block: "center", behavior: "smooth" }),
  };
}

/** What a reader reads one at a time: a paragraph, a heading, code, a table's row, a rule. */
const LINES = "p, h1, h2, h3, h4, h5, h6, pre, tr, hr";
const CHANGED = "ins, del, [data-change]";

/** The stretches of the version that changed, as runs of lines next to each other, where `root` draws them. */
function changeRuns(root: HTMLElement): { top: number; height: number; left: number }[] {
  const text = root.querySelector<HTMLElement>(".page-document");
  if (!text) return [];
  const frame = root.getBoundingClientRect();
  const left = Math.round(text.getBoundingClientRect().left - frame.left) - 14;
  const runs: { top: number; height: number; left: number }[] = [];
  let open: { top: number; bottom: number } | null = null;
  const close = () => {
    if (open) runs.push({ top: open.top, height: open.bottom - open.top, left });
    open = null;
  };
  for (const line of text.querySelectorAll<HTMLElement>(LINES)) {
    // A line inside something drawn whole, such as an embed, is part of it.
    if (line.parentElement?.closest(`${LINES}, [contenteditable="false"]`)) continue;
    // An empty line has nothing to read: it neither shows a change nor parts two of them.
    if (!line.matches("hr") && !line.textContent?.trim()) continue;
    if (!line.closest("[data-change]") && !line.querySelector(CHANGED)) { close(); continue; }
    const box = line.getBoundingClientRect();
    const top = box.top - frame.top + 4;
    const bottom = box.bottom - frame.top - 4;
    if (open) open.bottom = bottom;
    else open = { top, bottom };
  }
  close();
  return runs;
}

/**
 * Where a version changed, barred in brass in one line down the left margin, as a word processor bars changed
 * lines: lines changed next to each other are one bar, so a page mostly rewritten shows a few stretches to
 * read, not a mark beside every paragraph. The bar says where; the underline and strike-through say what.
 */
function PageVersionGutter({ column }: { column: RefObject<HTMLElement | null> }) {
  const [runs, setRuns] = useState<ReturnType<typeof changeRuns>>([]);
  useEffect(() => {
    const root = column.current;
    if (!root) return;
    let frameId = 0;
    const measure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const next = changeRuns(root);
        setRuns((current) => sameValue(current, next) ? current : next);
      });
    };
    measure();
    // The marks come with the version drawn, and the lines move as the column is resized.
    const changed = new MutationObserver(measure);
    changed.observe(root, { childList: true, subtree: true });
    const resized = new ResizeObserver(measure);
    resized.observe(root);
    return () => { cancelAnimationFrame(frameId); changed.disconnect(); resized.disconnect(); };
  }, [column]);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="page-version-gutter">
      {runs.map((run) => <span key={run.top} className="page-version-bar" style={run} />)}
    </div>
  );
}

/** The chosen version, drawn as the page is drawn, with what it changed marked in the text. */
export function PageHistoryDocument({ history, references, mediaUrl }: {
  history: PageHistoryState; references?: PageReferenceTargets; mediaUrl?: PageMediaUrl;
}) {
  const column = useRef<HTMLDivElement | null>(null);
  const { host, shown, marked } = history;
  const [drawn, setDrawn] = useState(false);
  useLayoutEffect(() => {
    const target = host.current;
    if (!target || !shown) return;
    if (marked) renderPageDiff(shown.doc, target, references, mediaUrl);
    else renderPageDocument(shown.after, target, references, mediaUrl);
    setDrawn(true);
  }, [host, shown, marked, references, mediaUrl]);
  // A version opens on its first change, when that is not on screen already: once the version stands
  // where it will, with nothing said above it any more.
  useEffect(() => {
    const first = drawn ? shown?.sections[0] : undefined;
    const block = first === undefined ? null : host.current?.children[first.index];
    if (!block) return;
    const box = block.getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight * 0.7) block.scrollIntoView({ block: "center" });
  }, [drawn, host, shown]);
  return (
    <div ref={column} className="relative" data-testid="page-history">
      {marked && <PageVersionGutter column={column} />}
      {!drawn && (
        <p className="min-h-[50vh] text-sm text-muted-foreground" role={history.failed ? "alert" : "status"}>
          {history.failed ? "Couldn't read this version." : "Reading the page's history…"}
        </p>
      )}
      {/* Kept while the next version is read, so choosing one never blanks the page. */}
      <div ref={host} className="ProseMirror page-document" data-editable="false" translate="no" data-testid="page-version"
        onClick={(event) => { if ((event.target as HTMLElement).tagName === "INPUT") event.preventDefault(); }} />
    </div>
  );
}

/** A version's time: the hour within its day's group. */
function versionTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Versions grouped by day, newest first: Today, Yesterday, then dates. */
function versionGroups(revisions: readonly PageRevision[]): Array<[string, PageRevision[]]> {
  const groups = new Map<string, PageRevision[]>();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  for (const revision of revisions) {
    const date = new Date(revision.createdAt);
    const day = date.toDateString() === today.toDateString() ? "Today"
      : date.toDateString() === yesterday.toDateString() ? "Yesterday"
        : date.toLocaleDateString(undefined, { month: "long", day: "numeric",
          ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
    groups.set(day, [...(groups.get(day) ?? []), revision]);
  }
  return [...groups];
}

function authorsOf(revisions: readonly PageRevision[]): PageAuthor[] {
  const authors = new Map<string, PageAuthor>();
  for (const revision of revisions) for (const author of revision.authors) authors.set(`${author.kind}:${author.id}`, author);
  return [...authors.values()];
}

function Authors({ authors }: { authors: readonly PageAuthor[] }) {
  return authors.map((author) => (
    <span key={`${author.kind}:${author.id}`} className="mt-0.5 flex items-center gap-1.5 text-xs">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: pageAuthorColor(author) }} />
      <span className="truncate" title={author.application ? "OAuth application name supplied by its registration" : undefined}>
        {pageAuthorLabel(author)}
      </span>
    </span>
  ));
}

/** New to this reader: the dot History's button carries. */
function NewDot() {
  return <span aria-label="New since your last visit" className="page-new-dot" />;
}

/**
 * The page's versions, beside the page where the margin is or folded to the chosen one above it: what is new
 * since the reader's last visit first, then every version by day, each with its time and its editors. The
 * chosen one names the sections it changed, each a way to that change.
 */
export function PageHistoryRail({ history, fold, conversationName, onOpenConversation }: {
  history: PageHistoryState;
  /** Without room beside the page: only the chosen version shows until the reader opens the list. */
  fold: boolean;
  conversationName: (conversationId: string) => string | null;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [listed, setListed] = useState(false);
  const { revisions, news, since, choice, version, shown } = history;
  const choose = (next: Choice) => { history.choose(next); setListed(false); };
  const row = (selected: boolean) => cn("w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", selected && "bg-accent");
  // Where the chosen version changed, under its own row.
  const where = (selected: boolean) => selected && shown && history.marked && (
    <ul className="pb-1.5 pl-2 pt-0.5" data-testid="page-version-sections">
      {shown.sections.length ? shown.sections.map((section) => (
        <li key={section.index}>
          <button type="button" onClick={() => history.jump(section.index)}
            className="page-version-section block w-full truncate py-0.5 pl-2 text-left text-xs text-muted-foreground hover:text-foreground">
            {section.title || "Top of the page"}
          </button>
        </li>
      )) : <li className="py-0.5 pl-2 text-xs text-muted-foreground">No change to its text</li>}
    </ul>
  );
  const sinceRow = news.length > 0 && (
    <div>
      <button type="button" onClick={() => choose("since")} aria-pressed={choice === "since"} className={row(choice === "since")}>
        <span className="flex items-center gap-1.5 font-semibold">Since your last visit <NewDot /></span>
        <span className="block text-xs text-muted-foreground">
          {news.length === 1 ? "1 version" : `${news.length} versions`}
        </span>
        <Authors authors={authorsOf(news)} />
      </button>
      {where(choice === "since")}
    </div>
  );
  const versionRow = (revision: PageRevision) => {
    const selected = version?.revision === revision.revision;
    return (
      <li key={revision.revision}>
        <button type="button" onClick={() => choose(revision.revision)} aria-pressed={selected}
          aria-label={`${versionTime(revision.createdAt)} by ${revision.authors.map(pageAuthorLabel).join(", ")}`}
          className={row(selected)}>
          <span className="flex items-center gap-1.5 font-semibold">
            {versionTime(revision.createdAt)}
            {since !== null && revision.revision > since && revision.kind !== "suggestion" && <NewDot />}
          </span>
          {revision.revision === revisions[0]?.revision && revision.kind !== "suggestion" && (
            <span className="block text-xs italic text-muted-foreground">Current version</span>
          )}
          {revision.kind !== "edit" && (
            <span className={cn("block text-xs", revision.kind === "suggestion" ? statusInkClass("attention")
              : "text-muted-foreground")}>{VERSION_KIND[revision.kind]}</span>
          )}
          <Authors authors={revision.authors} />
        </button>
        {selected && revision.conversationIds.map((conversationId) => conversationName(conversationId) && (
          <button key={conversationId} type="button" onClick={() => onOpenConversation(conversationId)}
            className="block px-2 pb-1 text-left text-xs text-muted-foreground hover:underline">
            in {conversationName(conversationId)}
          </button>
        ))}
        {where(selected)}
      </li>
    );
  };
  if (fold && !listed) {
    // The chosen version alone, as a line that opens the list.
    return (
      <div className="mb-4" data-testid="page-versions">
        <button type="button" onClick={() => setListed(true)} aria-expanded={false}
          className="flex w-full items-center gap-2 rounded-md bg-accent px-3 py-2 text-left text-sm">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">
              {choice === "since" ? "Since your last visit"
                : version ? `${new Date(version.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${versionTime(version.createdAt)}`
                  : "Version history"}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {(choice === "since" ? authorsOf(news) : version?.authors ?? []).map(pageAuthorLabel).join(", ")}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className={cn("space-y-3", fold && "mb-6")} data-testid="page-versions">
      <label className="flex items-center justify-between gap-2 px-2 text-sm">
        <span className="font-semibold">Show changes</span>
        <Switch label="Show changes" checked={history.marked} onChange={history.mark} />
      </label>
      {sinceRow}
      {versionGroups(revisions).map(([day, dayRevisions]) => (
        <section key={day}>
          <h3 className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{day}</h3>
          <ul className="space-y-0.5">{dayRevisions.map(versionRow)}</ul>
        </section>
      ))}
    </div>
  );
}

/** History's own header, in place of the page's: the way back, and putting the chosen version back. */
export function PageHistoryBar({ history, canEdit, onClose }: {
  history: PageHistoryState; canEdit: boolean; onClose: () => void;
}) {
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onClose} className="-ml-2"><ArrowLeft /> Back to the page</Button>
      <span className="mr-auto text-sm font-semibold">Version history</span>
      {history.error && <span role="alert" className={cn("text-xs", statusInkClass("alert"))}>{history.error}</span>}
      {canEdit && history.restore && (
        <Button size="sm" onClick={() => void history.restore!()}>
          {history.version?.kind === "suggestion" ? "Accept suggestion" : "Restore this version"}
        </Button>
      )}
    </>
  );
}

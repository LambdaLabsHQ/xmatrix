"use client";

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, FileText } from "lucide-react";
import { WEB_PROXY_ROUTES, HUB_ROUTES, pageEditGlimpses, type PageEditGlimpse, type PageEditSegment, type PageMessageEdit } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixHubRead } from "@/lib/query/hub-read";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi } from "@/lib/pages/page-client";
import { usePageReferenceScope } from "./page-reference-chip";
import { heldPageMessageEdits } from "./page-message-edits-hold";

/** Where a page opened from a message's edit card: what changed since, and the message to go back to. */
export interface PageEditOpening { since: number; from: { channelId: string; messageId: string } }

const NO_EDITS = new Map<string, readonly PageMessageEdit[]>();
/** How many changed lines a folded card previews, each on one line. */
const PREVIEW = 2;

/**
 * What the Agent messages on screen changed on pages, by message. Each is read once for the messages shown: a
 * message is sent after the edits it follows, so a new message is a new question and nothing needs to poll.
 */
export function useMessagePageEdits(channelId: string | null, token: string | null,
  messageIds: readonly string[]): ReadonlyMap<string, readonly PageMessageEdit[]> {
  const { user } = useAuth();
  const query = useQuery<{ edits?: PageMessageEdit[] }>({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-message-edits",
      [channelId ?? "", ...messageIds]),
    enabled: Boolean(channelId && token && messageIds.length),
    retry: false,
    staleTime: 60_000,
    placeholderData: (previous) => heldPageMessageEdits(previous, messageIds),
    queryFn: ({ signal }) => xmatrixHubRead<{ edits?: PageMessageEdit[] }>({ method: "POST",
      hubPath: HUB_ROUTES.channel_page_edits(channelId!), webUrl: WEB_PROXY_ROUTES.channel_page_edits(channelId!),
      body: { messageIds }, token: token!, signal }),
  });
  return useMemo(() => {
    if (!query.data?.edits?.length) return NO_EDITS;
    const byMessage = new Map<string, PageMessageEdit[]>();
    for (const edit of query.data.edits) byMessage.set(edit.messageId, [...byMessage.get(edit.messageId) ?? [], edit]);
    return byMessage;
  }, [query.data]);
}

/** The revisions an edit holds as runs that each follow on from the last: one diff per run. */
function editRuns(edit: PageMessageEdit): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (const { revision, basedOnRevision } of edit.revisions) {
    const base = basedOnRevision ?? revision - 1;
    const last = runs.at(-1);
    if (last && last.to === base) last.to = revision;
    else runs.push({ from: base, to: revision });
  }
  return runs;
}

/** The words before a line's first change that a one-line preview keeps, so the change itself stays in view. */
const LEAD = 28;

/** A changed line cut to its change: a long unchanged start keeps only the words just before what changed. */
function clippedSegments(glimpse: PageEditGlimpse): PageEditSegment[] {
  const [first, ...rest] = glimpse.segments;
  if (!first || first.change || first.text.length <= LEAD || !rest.length) return glimpse.segments;
  const tail = first.text.slice(-LEAD);
  const word = tail.search(/\s/u);
  return [{ text: `…${word > 0 ? tail.slice(word) : tail}` }, ...rest];
}

function Segments({ segments }: { segments: readonly PageEditSegment[] }) {
  return segments.map((segment, at) => segment.change === "added" ? <ins key={at}>{segment.text}</ins>
    : segment.change === "removed" ? <del key={at}>{segment.text}</del> : <span key={at}>{segment.text}</span>);
}

/**
 * The pages an Agent's message changed, drawn with it as a tool call's result is: one folded card per page. Folded,
 * it names the page and the sections changed, counts the lines added and taken out, and previews two changes each
 * on one line, cut to where the words changed, leading with what the page says now. Unfolded, it lists every change
 * by section, new words underlined and words taken out struck through, as the page itself marks what changed since
 * it was read. Open shows the page at that change.
 */
export function PageEditCards({ edits, channelId, messageId }: {
  edits: readonly PageMessageEdit[]; channelId: string; messageId: string;
}) {
  const scope = usePageReferenceScope();
  if (!scope) return null;
  return (
    <div className="app-page-edits">
      {edits.map((edit) => (
        <PageEditCard key={edit.pageId} edit={edit} spaceId={scope.spaceId} token={scope.token}
          onOpen={(blockId, since) => scope.onOpenPage(edit.pageId, blockId, { since, from: { channelId, messageId } })} />
      ))}
    </div>
  );
}

function PageEditCard({ edit, spaceId, token, onOpen }: {
  edit: PageMessageEdit; spaceId: string; token: string; onOpen: (blockId: string | null, since: number) => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const runs = useMemo(() => editRuns(edit), [edit]);
  const revisions = useMemo(() => [...new Set(runs.flatMap(({ from, to }) => [from, to]))], [runs]);
  const read = useQueries({
    queries: revisions.map((revision) => ({
      // Shared with the conversation's page cards: cache the complete document, and derive its body below.
      queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-document-revision",
        [spaceId, edit.pageId, revision]),
      enabled: revision > 0, staleTime: Infinity, retry: false,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        pageApi.read(spaceId, edit.pageId, token, revision, signal).then((result) => result.page),
    })),
    combine: (results) => ({ bodies: results.map((result) => result.data?.body), failed: results.some((result) => result.isError) }),
  });
  const { failed } = read;
  const glimpses = useMemo<PageEditGlimpse[] | null>(() => {
    // Before the first revision a page was empty.
    const body = (revision: number) => revision > 0 ? read.bodies[revisions.indexOf(revision)] : "";
    if (runs.some(({ from, to }) => body(from) === undefined || body(to) === undefined)) return null;
    return runs.flatMap(({ from, to }) => pageEditGlimpses(body(from)!, body(to)!));
  }, [read.bodies, revisions, runs]);
  // A page the reader cannot open, or an edit that changed only how the text is written, says nothing. Until
  // its revisions are read the card is not drawn either, so it never shows and then takes itself back.
  if (failed || !glimpses?.length) return null;
  const sections = [...new Set(glimpses.map((glimpse) => glimpse.section))];
  const named = sections.filter(Boolean);
  // A rewritten line counts as one line taken out and one added, as a code diff counts it.
  const added = glimpses.filter((glimpse) => glimpse.kind !== "removed").length;
  const removed = glimpses.filter((glimpse) => glimpse.kind !== "added").length;
  // The preview leads with what the page says now; lines only taken out come after, in page order.
  const preview = [...glimpses.filter((glimpse) => glimpse.kind !== "removed"),
    ...glimpses.filter((glimpse) => glimpse.kind === "removed")].slice(0, PREVIEW);
  const since = runs[0]!.from;
  const body = `page-edit-${edit.messageId}-${edit.pageId}`;
  return (
    <div className="app-page-edit" data-testid="page-edit-card" data-open={open || undefined}>
      <button type="button" className="app-page-edit-head" aria-expanded={open} aria-controls={body}
        onClick={() => setOpen((was) => !was)}>
        <FileText aria-hidden="true" className="app-page-edit-icon" />
        <span className="app-page-edit-title">{edit.title}</span>
        {named.length > 0 && <span className="app-page-edit-sections">{named.join(" · ")}</span>}
        <span className="app-page-edit-stat" aria-label={`${added} lines added, ${removed} taken out`}>
          {added > 0 && <span data-kind="added">+{added}</span>}
          {removed > 0 && <span data-kind="removed">−{removed}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="app-page-edit-chevron" />
      </button>
      <div id={body} className="app-page-edit-body">
        {open ? sections.map((section) => (
          <section key={section} className="app-page-edit-section">
            {named.length > 1 && section && <p className="app-page-edit-where">{section}</p>}
            {glimpses.filter((glimpse) => glimpse.section === section).map((glimpse, index) => (
              <p key={index} className="app-page-edit-line" data-kind={glimpse.kind}><Segments segments={glimpse.segments} /></p>
            ))}
          </section>
        )) : preview.map((glimpse, index) => (
          <p key={index} className="app-page-edit-line" data-kind={glimpse.kind} data-clipped="">
            <Segments segments={clippedSegments(glimpse)} />
          </p>
        ))}
        <p className="app-page-edit-foot">
          {!open && glimpses.length > PREVIEW
            ? <button type="button" className="app-page-edit-more" onClick={() => setOpen(true)}>{glimpses.length - PREVIEW} more</button>
            : <span />}
          <button type="button" className="app-page-edit-open" onClick={() => onOpen(glimpses[0]?.blockId || null, since)}>
            Open page <ArrowUpRight aria-hidden="true" />
          </button>
        </p>
      </div>
    </div>
  );
}

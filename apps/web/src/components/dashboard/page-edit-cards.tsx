"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { WEB_PROXY_ROUTES, HUB_ROUTES, pageEditGlimpses, type PageEditGlimpse, type PageMessageEdit } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixHubRead } from "@/lib/query/hub-read";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi } from "@/lib/pages/page-client";
import { usePageReferenceScope } from "./page-reference-chip";

/** Where a page opened from a message's edit card: what changed since, and the message to go back to. */
export interface PageEditOpening { since: number; from: { channelId: string; messageId: string } }

const NO_EDITS = new Map<string, readonly PageMessageEdit[]>();
/** How many changed lines a card shows before it says how many more there are. */
const SHOWN = 3;

/**
 * What the Agent messages on screen changed on pages, by message. Each is read once for the messages shown: a
 * message is sent after the edits it follows, so a new message is a new question and nothing needs to poll.
 */
export function useMessagePageEdits(channelId: string | null, token: string | null,
  messageIds: readonly string[]): ReadonlyMap<string, readonly PageMessageEdit[]> {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-message-edits",
      [channelId ?? "", ...messageIds]),
    enabled: Boolean(channelId && token && messageIds.length),
    retry: false,
    staleTime: 60_000,
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

/**
 * The pages an Agent's message changed, drawn with it as a tool call's result is: one card per page, its name
 * first and largest, then each changed line where it stands, new words underlined and words taken out struck
 * through, as the page itself marks what changed since it was read. Opening it shows the page at that change.
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
  // A page the reader cannot open, or an edit that changed only how the text is written, says nothing.
  if (failed || glimpses?.length === 0) return null;
  const shown = glimpses ?? [];
  const sections = [...new Set(shown.map((glimpse) => glimpse.section).filter(Boolean))];
  const oneSection = sections.length === 1 && shown.every((glimpse) => glimpse.section === sections[0]);
  const since = runs[0]!.from;
  const open = () => onOpen(shown[0]?.blockId || null, since);
  return (
    <div role="link" tabIndex={0} className="app-page-edit" data-testid="page-edit-card"
      aria-label={`${edit.title}: open the page at this change`} onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
      <p className="app-page-edit-title">
        <FileText aria-hidden="true" />
        <span>{edit.title}{oneSection && <> › {sections[0]}</>}</span>
      </p>
      {glimpses ? <>
        <p className="app-page-edit-count">
          <strong>{shown.length === 1 ? "1 change" : `${shown.length} changes`}</strong>
          {!oneSection && sections.length > 0 && <> · {sections.slice(0, 4).join(", ")}</>}
        </p>
        {shown.slice(0, SHOWN).map((glimpse, index) => (
          <div key={index} className="app-page-edit-line" data-kind={glimpse.kind}>
            {(!oneSection || glimpse.kind !== "changed") && (
              <span className="app-page-edit-where">
                {[!oneSection && glimpse.section, glimpse.kind === "added" ? "New" : glimpse.kind === "removed" ? "Removed" : null]
                  .filter(Boolean).join(" · ")}
              </span>
            )}
            {glimpse.segments.map((segment, at) => segment.change === "added" ? <ins key={at}>{segment.text}</ins>
              : segment.change === "removed" ? <del key={at}>{segment.text}</del> : <span key={at}>{segment.text}</span>)}
          </div>
        ))}
        {shown.length > SHOWN && (
          <p className="app-page-edit-more">
            <span>{shown.length - SHOWN} more</span><span className="app-page-edit-open">Open in page →</span>
          </p>
        )}
      </> : <p className="app-page-edit-count app-page-edit-loading">Reading the change…</p>}
    </div>
  );
}

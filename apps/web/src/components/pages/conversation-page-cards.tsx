"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { pageBlocks, pageLineDiff } from "@xmatrix/protocol";
import { FileText } from "lucide-react";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi, type PageDocument } from "@/lib/pages/page-client";
import { pageStatusLine, ReferenceChip } from "@/components/dashboard/page-reference-chip";

const MAX_CARDS = 4;

export type ConversationPage = {
  pageId: string;
  page: PageDocument;
  section: ReturnType<typeof pageBlocks>[number] | undefined;
  blockId: string;
  /** A discussion's passage, when the link is an open discussion. */
  quote: string | null;
};

/**
 * The pages a conversation touches, one per page: a discussion's passage
 * first, else the section most recently touched. Pages refresh with their
 * document, so whatever shows them always shows current state.
 */
export function useConversationPages({ spaceId, conversationId, token, excludePageId = null }: {
  spaceId: string; conversationId: string; token: string | null;
  excludePageId?: string | null;
}): ConversationPage[] {
  const { user } = useAuth();
  const identity = { userId: user?.id ?? "anonymous" };
  const links = useQuery({
    queryKey: xmatrixQueryKeys.domain(identity, "conversation-page-links", [spaceId, conversationId]),
    enabled: Boolean(token && user?.id), refetchInterval: 30_000, retry: false,
    queryFn: ({ signal }) => pageApi.links(spaceId, token!, { conversationId }, signal).then((result) => result.links),
  });
  const targets = useMemo(() => {
    const seen = new Map<string, { blockId: string; quote: string | null }>();
    for (const link of links.data ?? []) {
      if (link.pageId === excludePageId) continue;
      const quote = link.anchor && !link.resolvedAt ? link.anchor.quote : null;
      if (!seen.has(link.pageId) || (quote && !seen.get(link.pageId)!.quote)) {
        seen.set(link.pageId, { blockId: link.blockId, quote });
      }
    }
    return [...seen.entries()].slice(0, MAX_CARDS);
  }, [excludePageId, links.data]);
  const pages = useQueries({
    queries: targets.map(([pageId]) => ({
      queryKey: xmatrixQueryKeys.domain(identity, "page-document", [spaceId, pageId]),
      enabled: Boolean(token),
      staleTime: 15_000, refetchInterval: 30_000, retry: false,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        pageApi.read(spaceId, pageId, token!, undefined, signal).then((result) => result.page),
    })),
  });
  return targets.flatMap(([pageId, { blockId, quote }], index) => {
    const page = pages[index]?.data;
    if (!page) return [];
    const section = pageBlocks(page.body).find((block) => block.id === blockId);
    return [{ pageId, page, section, blockId, quote }];
  });
}

function sectionText(body: string, blockId: string): string {
  const block = pageBlocks(body).find((item) => item.id === blockId);
  return block ? body.slice(block.start, block.end) : "";
}

/** A diff line as prose: no list, quote or heading marks. */
function proseLine(line: string): string {
  return line.trim().replace(/^(?:#{1,6}\s+|[-*>]\s+|\d+\.\s+)/u, "").trim();
}

type SectionChange = { author: string; at: string; text: string };

/**
 * What the last change to a section did, roughly: who, when, and the first
 * line it added (or removed). A revision reads as what it changed from the one
 * it was based on, as History reads it. Null while unknown or never changed.
 */
function useSectionChange({ spaceId, page, blockId, token }: {
  spaceId: string; page: PageDocument; blockId: string; token: string;
}): SectionChange | null {
  const { user } = useAuth();
  const identity = { userId: user?.id ?? "anonymous" };
  const pageId = page.pageId;
  const awareness = useQuery({
    queryKey: xmatrixQueryKeys.domain(identity, "page-awareness", [spaceId, pageId, page.headRevision]),
    enabled: Boolean(token), refetchInterval: 30_000, retry: false,
    queryFn: ({ signal }) => pageApi.awareness(spaceId, pageId, token, signal),
  });
  const updated = awareness.data?.blocks.find((block) => block.blockId === blockId)?.updated ?? null;
  const revisionQuery = (revision: number | null | undefined) => ({
    queryKey: xmatrixQueryKeys.domain(identity, "page-document-revision", [spaceId, pageId, revision ?? 0]),
    // A revision never changes once written.
    enabled: Boolean(token && revision), staleTime: Infinity, retry: false,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      pageApi.read(spaceId, pageId, token, revision!, signal).then((result) => result.page),
  });
  const after = useQuery(revisionQuery(updated && updated.revision !== page.headRevision ? updated.revision : null));
  const changed = updated?.revision === page.headRevision ? page : after.data;
  const previous = changed
    ? changed.revisionInfo.basedOnRevision
      ?? (changed.revisionInfo.revision > 1 ? changed.revisionInfo.revision - 1 : null)
    : null;
  const before = useQuery(revisionQuery(previous));
  return useMemo(() => {
    if (!updated || !changed || !before.data) return null;
    const diff = pageLineDiff(sectionText(before.data.body, blockId), sectionText(changed.body, blockId));
    const first = (kind: "added" | "removed") => diff.filter((part) => part.kind === kind)
      .flatMap((part) => part.lines).map(proseLine).find(Boolean);
    const added = first("added");
    const removed = added ? undefined : first("removed");
    if (!added && !removed) return null;
    return {
      author: updated.authors.map((author) => author.label).join(", "),
      at: updated.createdAt,
      text: added ?? `Removed “${removed}”`,
    };
  }, [before.data, blockId, changed, updated]);
}

/**
 * The pages a conversation touches, under its header like Slack's bookmarks:
 * each names the page and section, and says in small type what the last
 * change there did (who, when, the line it added), or else what the section
 * says now. Hovering previews the section; a click opens the page. On a phone
 * the channel's Summary plaque carries them instead, so this line is md+ only.
 */
export function ConversationPageCards({ spaceId, conversationId, token, onOpenPage, excludePageId = null }: {
  spaceId: string; conversationId: string; token: string; onOpenPage: (pageId: string) => void;
  /** Beside a page, that page is already in view. */
  excludePageId?: string | null;
}) {
  const pages = useConversationPages({ spaceId, conversationId, token, excludePageId });
  if (pages.length === 0) return null;
  return (
    <nav aria-label="Pages" className="conversation-page-bookmarks hidden shrink-0 items-start gap-1 overflow-x-auto px-2 py-1.5 md:flex"
      data-testid="conversation-page-cards">
      {pages.map((entry) => (
        <ConversationPageBookmark key={entry.pageId} spaceId={spaceId} token={token} entry={entry}
          onOpen={() => onOpenPage(entry.pageId)} />
      ))}
    </nav>
  );
}

function ConversationPageBookmark({ spaceId, token, entry: { page, section, blockId, quote }, onOpen }: {
  spaceId: string; token: string; entry: ConversationPage; onOpen: () => void;
}) {
  const change = useSectionChange({ spaceId, page, blockId, token });
  const heading = section ? `${page.title} › ${section.title}` : page.title;
  const now = pageStatusLine(page, blockId);
  // A discussion is about its passage; otherwise the last change, else what the section says now.
  const detail = quote ? `“${quote}”` : change?.text ?? (now || "—");
  return (
    <ReferenceChip
      className="conversation-page-bookmark"
      icon={<FileText aria-hidden="true" />}
      label={<>
        <span className="conversation-page-bookmark-head">
          <span className="conversation-page-bookmark-title">
            {page.title}{section && <span className="conversation-page-bookmark-section"> › {section.title}</span>}
          </span>
          {!quote && change && (
            <span className="conversation-page-bookmark-who">{change.author} {formatRelativeAge(change.at) ?? ""}</span>
          )}
        </span>
        <span className={`conversation-page-bookmark-detail${quote ? " italic" : ""}`}>{detail}</span>
      </>}
      title={heading}
      preview={quote ? `“${quote}”` : now || "Open this page"}
      ariaLabel={`Open page ${heading}`}
      testId="conversation-page"
      data={{ "data-page-id": page.pageId }}
      onOpen={onOpen} />
  );
}

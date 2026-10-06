"use client";

/**
 * Inline `page:<id>` and `channel:<id>` references in messages
 * (pages-and-conversations.md §4.3): a chip with the page title (and section)
 * or the channel name, a hover preview of what it says now, and a click that
 * opens it. The header's page bookmarks are the same chip, listed under the
 * channel; this is it mid-sentence.
 */
import { createContext, Fragment, memo, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Hash, Lock } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import {
  messageReferenceSpans,
  pageBlocks,
  type ChannelReferenceSpan,
  type MessageReferenceSpan,
  type PageReferenceSpan,
} from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi, type PageDocument } from "@/lib/pages/page-client";
import { ContentSkeleton } from "@/components/dashboard/content-skeleton";
import { useAppPortalContainer } from "./app-portal-container";
import { useMessageReferenceCatalog } from "./message-reference-catalog";
import { channelLabel } from "./reference-complete";

export type PageReferenceScope = {
  spaceId: string;
  token: string;
  onOpenPage: (pageId: string, blockId?: string | null) => void;
};

/** The first meaningful line of a section: what the page says about it now. */
export function pageStatusLine(page: PageDocument, blockId: string): string {
  const blocks = pageBlocks(page.body);
  const block = blocks.find((item) => item.id === blockId)
    ?? blocks.find((item) => /^status$/iu.test(item.title))
    ?? blocks[0];
  if (!block) return "";
  const lines = page.body.slice(block.start, block.end).split("\n")
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return (lines[0] ?? "").replace(/^[-*>]\s*/u, "").slice(0, 160);
}

const PageReferenceContext = createContext<PageReferenceScope | null>(null);

export function PageReferenceScopeProvider({
  scope,
  children,
}: {
  scope: PageReferenceScope | null;
  children: ReactNode;
}) {
  return <PageReferenceContext.Provider value={scope}>{children}</PageReferenceContext.Provider>;
}

/** Replace each `page:<id>` and `channel:<id>` in plain text with a live chip. */
export const PageReferenceRichText = memo(function PageReferenceRichText({ text }: { text: string }) {
  const spans = useMemo(() => messageReferenceSpans(text), [text]);
  if (!spans.length) return <>{text}</>;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      pieces.push(<Fragment key={`t-${cursor}`}>{text.slice(cursor, span.start)}</Fragment>);
    }
    pieces.push(<MessageReferenceChip key={`r-${span.start}`} span={span} />);
    cursor = span.end;
  }
  if (cursor < text.length) pieces.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  return <>{pieces}</>;
});

export function MessageReferenceChip({ span }: { span: MessageReferenceSpan }) {
  return span.kind === "channel" ? <ChannelReferenceChip span={span} /> : <PageReferenceChip span={span} />;
}

/** The chip and its hover preview, shared by page and channel references. */
export function ReferenceChip({ icon, label, title, badge, preview, ariaLabel, testId, data, onOpen,
  className = "app-page-reference-chip" }: {
  icon: ReactNode;
  label: ReactNode;
  title: string;
  badge?: string | null;
  preview: ReactNode;
  ariaLabel: string;
  testId: "page-reference" | "channel-reference" | "conversation-page";
  data: Record<`data-${string}`, string | undefined>;
  onOpen: () => void;
  className?: string;
}) {
  const portal = useAppPortalContainer();
  return (
    <Popover.Root>
      <Popover.Trigger
        ref={portal.triggerRef}
        openOnHover
        delay={220}
        closeDelay={160}
        nativeButton={false}
        render={<button type="button" />}
        className={className}
        data-testid={`${testId}-chip`}
        {...data}
        aria-label={ariaLabel}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
      >
        <span className="app-page-reference-chip-icon" aria-hidden="true">{icon}</span>
        <span className="app-page-reference-chip-label">{label}</span>
      </Popover.Trigger>
      <Popover.Portal container={portal.container}>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="app-page-reference-positioner"
        >
          <Popover.Popup
            className="app-page-reference-popup"
            data-testid={`${testId}-preview`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            <div className="app-page-reference-popup-title">
              {icon}
              <Popover.Title>{title}</Popover.Title>
              {badge && <span className="app-page-reference-popup-rev">{badge}</span>}
            </div>
            <Popover.Description className="app-page-reference-popup-body">{preview}</Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RawReference({ text }: { text: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{text}</code>;
}

const ChannelReferenceChip = memo(function ChannelReferenceChip({ span }: { span: ChannelReferenceSpan }) {
  const catalog = useMessageReferenceCatalog();
  if (!catalog) return <RawReference text={span.text} />;
  const channel = catalog.channels.find((candidate) => candidate.id === span.channelId);
  // A channel this reader cannot see says so, and names nothing about it.
  if (!channel) {
    return (
      <span className="app-page-reference-chip app-page-reference-chip-unavailable"
        data-testid="channel-reference-chip" data-channel-id={span.channelId}>
        <span className="app-page-reference-chip-icon" aria-hidden="true"><Lock /></span>
        <span className="app-page-reference-chip-label">private channel</span>
      </span>
    );
  }
  const name = channelLabel(channel);
  return (
    <ReferenceChip
      icon={<Hash aria-hidden="true" />}
      label={name}
      title={name}
      preview={channel.topic?.trim() || channel.summary?.trim() || "Open this channel"}
      ariaLabel={`Open channel ${name}`}
      testId="channel-reference"
      data={{ "data-channel-id": span.channelId }}
      onOpen={() => catalog.onOpenChannel(channel.id)}
    />
  );
});

export const PageReferenceChip = memo(function PageReferenceChip({ span }: { span: PageReferenceSpan }) {
  const scope = useContext(PageReferenceContext);
  const { user } = useAuth();
  const identity = { userId: user?.id ?? "anonymous" };
  const enabled = Boolean(scope?.spaceId && scope.token && user?.id);
  const page = useQuery({
    queryKey: xmatrixQueryKeys.domain(identity, "page-document", [scope?.spaceId ?? "", span.pageId]),
    enabled, staleTime: 15_000, refetchInterval: 30_000, retry: false,
    queryFn: ({ signal }) =>
      pageApi.read(scope!.spaceId, span.pageId, scope!.token, undefined, signal).then((result) => result.page),
  });
  const title = page.data?.title?.trim() || "Page";
  const section = useMemo(() => {
    if (!span.blockId) return null;
    const block = page.data ? pageBlocks(page.data.body).find((candidate) => candidate.id === span.blockId) : undefined;
    return { title: block?.title.trim() || span.blockId, body: block && page.data
      ? page.data.body.slice(block.start, block.end).split("\n").slice(1).join(" ").replace(/\s+/gu, " ").trim()
      : "" };
  }, [page.data, span.blockId]);
  const preview = section ? section.body : page.data ? pageStatusLine(page.data, "") : "";
  const revisionLabel = span.revision != null
    ? `r${span.revision}`
    : page.data ? `r${page.data.headRevision}` : null;
  const heading = section ? `${title} › ${section.title}` : title;
  const label = revisionLabel ? `${heading} · ${revisionLabel}` : heading;

  if (!scope) return <RawReference text={span.text} />;

  return (
    <ReferenceChip
      icon={<FileText aria-hidden="true" />}
      label={page.isLoading ? "…" : label}
      title={heading}
      badge={revisionLabel}
      preview={page.isError
        ? "This page could not be loaded."
        : preview || (page.isLoading
          ? <ContentSkeleton label="Loading page" lines={3} />
          : "Open this page")}
      ariaLabel={`Open page ${heading}`}
      testId="page-reference"
      data={{ "data-page-id": span.pageId, "data-block-id": span.blockId ?? undefined }}
      onOpen={() => scope.onOpenPage(span.pageId, span.blockId)}
    />
  );
});

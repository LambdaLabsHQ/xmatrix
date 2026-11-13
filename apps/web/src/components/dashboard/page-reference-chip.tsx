"use client";

/**
 * Inline `page:<id>`, `channel:<id>` and `request:<ref>` references in messages
 * (pages-and-conversations.md §4.3): a chip with the page title (and section)
 * or the channel name, a hover preview of what it says now, and a click that
 * opens it. The header's page bookmarks are the same chip, listed under the
 * channel; this is it mid-sentence.
 */
import { createContext, Fragment, memo, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, FileText, Hash, Lock } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import {
  messageReferenceSpans,
  pageBlocks,
  type ChannelReferenceSpan,
  type MessageReferenceSpan,
  type NornRequestView,
  type PageReferenceSpan,
  type RequestReferenceSpan,
} from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi, type PageDocument } from "@/lib/pages/page-client";
import { ContentSkeleton } from "@/components/dashboard/content-skeleton";
import { useAppPortalContainer } from "./app-portal-container";
import { useMessageReferenceCatalog } from "./message-reference-catalog";
import { channelLabel } from "./reference-complete";
import { InlineRowPreview } from "./inline-row-preview";
import { referencePreview } from "./reference-preview";
import { requestSummary } from "./request-summary";
import type { PageEditOpening } from "./page-edit-cards";

export type PageReferenceScope = {
  spaceId: string;
  token: string;
  /** `opening` names the message to go back to, when an edit card opens it. */
  onOpenPage: (pageId: string, blockId?: string | null, opening?: PageEditOpening) => void;
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
  return (lines[0] ?? "").replace(/^(?:[-*+]\s+|>\s*)/u, "").slice(0, 160);
}

const PageReferenceContext = createContext<PageReferenceScope | null>(null);

/** The Space's pages, as the timeline around a message reaches them; null outside one. */
export function usePageReferenceScope(): PageReferenceScope | null {
  return useContext(PageReferenceContext);
}

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
  return span.kind === "channel" ? <ChannelReferenceChip span={span} />
    : span.kind === "request" ? <RequestReferenceChip span={span} /> : <PageReferenceChip span={span} />;
}

/** The chip and its hover preview, shared by page and channel references. */
export function ReferenceChip({ icon, label, title, badge, preview, ariaLabel, testId, data, onOpen,
  className = "app-page-reference-chip", popupClassName = "" }: {
  icon: ReactNode;
  label: ReactNode;
  title: string;
  badge?: string | null;
  preview: ReactNode;
  ariaLabel: string;
  testId: "page-reference" | "channel-reference" | "conversation-page" | "request-reference";
  data: Record<`data-${string}`, string | undefined>;
  onOpen: () => void;
  className?: string;
  /** Added to the preview's panel, for a reference whose preview is more than a status line. */
  popupClassName?: string;
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
        render={<span />}
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
            className={`app-page-reference-popup ${popupClassName}`.trim()}
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

function UnavailableReference({ kind }: { kind: "page" | "channel" }) {
  return <span className="app-page-reference-chip app-page-reference-chip-unavailable">
    <span className="app-page-reference-chip-icon" aria-hidden="true"><Lock /></span>
    <span className="app-page-reference-chip-label">{kind === "page" ? "Page" : "Channel"}</span>
  </span>;
}

const ChannelReferenceChip = memo(function ChannelReferenceChip({ span }: { span: ChannelReferenceSpan }) {
  const catalog = useMessageReferenceCatalog();
  if (!catalog) return <UnavailableReference kind="channel" />;
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

const REQUEST_STATES = { open: "waiting for", answered: "answered by", refused: "declined by", broke: "could not be done by",
  no_reply: "not answered in time by", cancelled: "withdrawn from", revoked: "withdrawn from" } as const;

/**
 * A request a Norn program made, in place of its reference: what was asked,
 * of whom and how it stands. A reader who cannot read its conversation sees
 * only that it is a request.
 *
 * This is a reference inside a sentence. The chip says how the request starts;
 * a task is often a long paragraph, and the whole of it is read in the
 * preview, which scrolls. The delivery message's own request is not a chip:
 * it is RequestReferenceBlock.
 *
 * Its mark is a task sheet. A question mark in a circle read as "unknown" or
 * "something went wrong" beside a task that is simply under way.
 */
/** The request a reference names, for whoever can read its conversation; `unavailable` for anyone else. */
function useNornRequest(requestRef: string) {
  const scope = useContext(PageReferenceContext);
  const { user } = useAuth();
  const request = useQuery<NornRequestView>({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "norn-request", [scope?.spaceId ?? "", requestRef]),
    enabled: Boolean(scope?.spaceId && scope.token && user?.id), retry: false,
    // An open request is read again so it says when it has been answered; an ended one does not change.
    staleTime: 15_000, refetchInterval: (query) => (query.state.data?.state === "open" ? 30_000 : false),
    queryFn: ({ signal }) => pageApi.request(scope!.spaceId, requestRef, scope!.token, signal),
  });
  const found = request.data;
  return { found, unavailable: !scope || request.isError || (!found && !request.isLoading) };
}

function UnavailableRequest() {
  return (
    <span className="app-page-reference-chip app-page-reference-chip-unavailable" data-testid="request-reference-chip">
      <span className="app-page-reference-chip-icon" aria-hidden="true"><Lock /></span>
      <span className="app-page-reference-chip-label">a request</span>
    </span>
  );
}

/**
 * The request a delivery message is about, in place of its "Request" line:
 * the whole of what was asked, as the paragraphs it was written in and in the
 * message's own body text, under a line saying whom it waits for or how it
 * ended. A task is something to read, so none of it is cut and none of it is
 * drawn as a chip.
 */
export const RequestReferenceBlock = memo(function RequestReferenceBlock({ requestRef }: { requestRef: string }) {
  const { found, unavailable } = useNornRequest(requestRef);
  if (unavailable) return <p className="app-request-block-unavailable"><strong>Request</strong> <UnavailableRequest /></p>;
  const paragraphs = found?.text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean) ?? [];
  return (
    <div className="app-request-block" data-testid="request-reference-block" data-request-state={found?.state}>
      <p className="app-request-block-head">
        <ClipboardList aria-hidden="true" />
        <strong>Request</strong>
        {found && <span>{REQUEST_STATES[found.state]} {found.holder}</span>}
      </p>
      {found ? paragraphs.map((paragraph, index) => <p key={index} className="app-request-block-paragraph"><InlineRowPreview text={paragraph} /></p>)
        : <ContentSkeleton label="Loading request" lines={2} />}
      {found?.reply && <p className="app-request-block-reply"><strong>{found.holder}</strong> <InlineRowPreview text={found.reply} /></p>}
    </div>
  );
});

const RequestReferenceChip = memo(function RequestReferenceChip({ span }: { span: RequestReferenceSpan }) {
  const catalog = useMessageReferenceCatalog();
  const { found, unavailable } = useNornRequest(span.requestRef);
  if (unavailable) return <UnavailableRequest />;
  const asked = found ? requestSummary(referencePreview(found.text, catalog)) : "";
  const stands = found ? `${REQUEST_STATES[found.state]} ${found.holder}` : "";
  return (
    <ReferenceChip
      icon={<ClipboardList aria-hidden="true" />}
      label={found ? asked : "…"}
      title="Request"
      badge={found ? stands : null}
      preview={found ? <InlineRowPreview text={[found.text, found.reply ? `${found.holder}: ${found.reply}` : `It is ${stands}.`].join("\n\n")} />
        : <ContentSkeleton label="Loading request" lines={2} />}
      ariaLabel={`Open the request: ${asked}`}
      testId="request-reference"
      popupClassName="app-request-reference-popup"
      data={{ "data-request-state": found?.state }}
      onOpen={() => { if (found) catalog?.onOpenChannel(found.channelId); }}
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
    return { title: block?.title.trim() || "Section", body: block && page.data
      ? page.data.body.slice(block.start, block.end).split("\n").slice(1).join(" ").replace(/\s+/gu, " ").trim()
      : "" };
  }, [page.data, span.blockId]);
  const preview = section ? section.body : page.data ? pageStatusLine(page.data, "") : "";
  const revisionLabel = span.revision != null
    ? `r${span.revision}`
    : page.data ? `r${page.data.headRevision}` : null;
  const heading = section ? `${title} › ${section.title}` : title;
  const label = revisionLabel ? `${heading} · ${revisionLabel}` : heading;

  if (!scope) return <UnavailableReference kind="page" />;

  return (
    <ReferenceChip
      icon={<FileText aria-hidden="true" />}
      label={page.isLoading ? "…" : label}
      title={heading}
      badge={revisionLabel}
      preview={page.isError
        ? "This page could not be loaded."
        : preview ? <InlineRowPreview text={preview} /> : (page.isLoading
          ? <ContentSkeleton label="Loading page" lines={3} />
          : "Open this page")}
      ariaLabel={`Open page ${heading}`}
      testId="page-reference"
      data={{ "data-page-id": span.pageId, "data-block-id": span.blockId ?? undefined }}
      onOpen={() => scope.onOpenPage(span.pageId, span.blockId)}
    />
  );
});

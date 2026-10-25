"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { pageAuthorColor, pageAuthorLabel, pageLineDiff, type FaceOf, type PageLineDiff } from "@xmatrix/protocol";
import type { PageDocBlock } from "@xmatrix/protocol/page-document";
import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import {
  CenteredDialogShell, DialogButton, DialogInset, DialogPanelFooter, DialogPanelHeader,
} from "@/components/dashboard/centered-dialog-shell";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { InlineRowPreview } from "@/components/dashboard/inline-row-preview";
import { Button } from "@/components/ui/button";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { noticeClass, statusInkClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { pageApi, type PageRevision } from "@/lib/pages/page-client";
import { cn } from "@/lib/utils";
import { agentState } from "./page-margin";
import { PenContent } from "./page-pen";
import type { MarginConversation } from "./page-margin-model";
import { userErrorMessage } from "@/lib/user-facing-error";

/**
 * Around a page (pages-live-document.md §3.2, §7): who is on it, its menu,
 * and the dialogs that hold what a side panel used to. Everything that is
 * about a place in the page is drawn at that place instead.
 */

/** One avatar in the page's presence stack: who, and what they are doing where. */
export interface PresentPerson {
  key: string;
  name: string;
  color: string;
  agent: boolean;
  /** Their face: a person's own picture, an Agent's vendor mark. */
  face: FaceOf;
  /** What they are doing, where, and in which conversation. */
  detail: string;
  blockId: string;
  /** Where on the page they are, as a margin anchor: their caret, else their section. */
  anchor: string;
  /** They are changing the page, not only reading it. */
  editing: boolean;
  /** Away from the page, or an Agent whose Run is not working: dimmed, as Google Docs dims idle people. */
  idle?: boolean;
  /** The conversation an Agent works from, where it is talked to. */
  conversationId?: string | null;
  /** An Agent co-writing live whose last change can still be taken back. */
  undoable?: boolean;
  /** What an Agent co-writing live is doing now, in a word or two. */
  doing?: string;
  /** The conversation an Agent's words come from while it writes, by name. */
  from?: string;
  /** An Agent co-writing live whose last answer went quiet and was given up: another may write instead. */
  stalled?: boolean;
  /** An Agent co-writing live is thinking: its `doing` says for how long. */
  thinking?: boolean;
  /** How long it has thought, as briefly as a face's tag can say it: "19s", "2m". */
  brief?: string;
}

/** Room a face needs to carry its name beside it. */
const NAMED_PEN_ROOM = 110;

/** An Agent on the page, by the line it is at: its top in the document column, and whether that is out of view. */
export interface PagePen { person: PresentPerson; top: number; away: "above" | "below" | null }

/**
 * Each Agent on the page, on a phone and a desktop alike, is its face at the right edge beside the line its pen is at, where
 * Google Docs keeps what others do to the text (§3.2). The face travels with the text, and when the line
 * is scrolled out of view it waits at the top or bottom of the edge, pointing the way. A tap on a face
 * that is away goes back to its line; on one beside its line, it opens what the Agent is doing.
 */
export function PagePens({ pens, room = 0, onJump, onOpen }: {
  pens: PagePen[];
  /** Room beside the text column. Where a face fits with its name (a desktop), it carries its name and what it
   *  is doing, filled in its colour; on a phone it is the face alone. */
  room?: number;
  onJump: (person: PresentPerson) => void; onOpen: (person: PresentPerson) => void;
}) {
  if (pens.length === 0) return null;
  const named = room >= NAMED_PEN_ROOM;
  return (
    <div className={cn("page-pens pointer-events-none absolute inset-y-0", named ? "is-named left-full ml-2.5" : "-right-6 w-8")}
      style={named ? { width: room - 18 } : undefined} data-testid="page-pens">
      {pens.map(({ person, top, away }) => {
        const Chevron = away === "above" ? ChevronUp : ChevronDown;
        return (
          // A spacer, not a margin, sets the line: a sticky face may not leave its own margin box.
          <div key={person.key} className="absolute inset-0">
            {/* Its height eases, so the face glides to the line the Agent moves on to. */}
            <div className="page-pen-spacer" style={{ height: Math.max(0, top) }} />
            <button type="button" onClick={() => (away ? onJump(person) : onOpen(person))} data-away={away ?? undefined}
              className={cn("page-pen pointer-events-auto", person.idle && "is-idle", person.editing && "is-writing")}
              style={{ "--page-pen-color": person.color } as CSSProperties}
              aria-label={`${person.name} is ${person.editing ? "writing" : "here"}${away ? `, ${away}` : ""}`}
              title={`${person.name} · ${person.detail}`}>
              <PenContent person={person} named={named} />
              {away && <Chevron className="page-pen-way" aria-hidden="true" strokeWidth={2.5} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The change in front of the reader, held at the right edge beside its line, where Google Docs keeps
 * what others do to the text: whose change it is and what to do with it, travelling with the line and
 * waiting at the top or bottom of the edge, pointing the way, while the line is out of view.
 */
export function PageChangeMark({ top, away, label, testId, children }: {
  top: number; away: "above" | "below" | null; label: string; testId: string; children: ReactNode;
}) {
  const Chevron = away === "above" ? ChevronUp : ChevronDown;
  return (
    <div className="page-change-lane pointer-events-none absolute inset-y-0" data-testid={testId}>
      {/* A spacer, not a margin, sets the line: a sticky mark may not leave its own margin box. */}
      <div style={{ height: Math.max(0, top) }} />
      <div className="page-change-mark" data-away={away ?? undefined}>
        {away === "above" && <Chevron className="page-change-way" aria-hidden="true" strokeWidth={2.5} />}
        <LiquidGlassPill role="toolbar" aria-label={label}
          className="pointer-events-auto flex w-10 flex-col items-center gap-1 rounded-full p-1">
          {children}
        </LiquidGlassPill>
        {away === "below" && <Chevron className="page-change-way" aria-hidden="true" strokeWidth={2.5} />}
      </div>
    </div>
  );
}

/** A place on the page worth finding, drawn along its scrollbar (§3.2). */
export interface PageScrollMark { key: string; fraction: number; kind: "person" | "discussion"; color?: string;
  title: string }

/** Where others are and where discussions are, along the page's scrollbar. */
export function PageScrollMarks({ marks }: { marks: PageScrollMark[] }) {
  if (marks.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-1.5" aria-hidden="true" data-testid="page-scroll-marks">
      {marks.map((mark) => (
        <span key={mark.key} title={mark.title}
          className={cn("absolute right-0 h-1 w-1.5 rounded-l-sm", mark.kind === "discussion" && "page-scroll-mark-discussion")}
          style={{ top: `calc(${Math.min(1, Math.max(0, mark.fraction)) * 100}% - 2px)`,
            ...(mark.kind === "person" && mark.color ? { backgroundColor: mark.color } : {}) }} />
      ))}
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange, children }: {
  label: string; checked: boolean; disabled?: boolean; onChange: () => void; children?: ReactNode;
}) {
  return (
    <DialogInset as="label" className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-1" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="min-w-0">
        <span className="block font-semibold">{label}</span>
        {children && <span className="mt-0.5 block text-xs text-muted-foreground">{children}</span>}
      </span>
    </DialogInset>
  );
}

/** Who reads the page and how Agents change it (§7): publishing is a Space owner's or admin's act. */
export function ShareDialog({ open, onClose, canPublish, canEdit, published, restricted, publicUrl, suggestOnly,
  rulesPage, onTogglePublished, onToggleSuggestOnly, onToggleRulesPage, onCopyLink }: {
  open: boolean; onClose: () => void;
  canPublish: boolean; canEdit: boolean; published: boolean; restricted: boolean; publicUrl: string | null;
  suggestOnly: boolean | undefined;
  /** Whether this page states the project's rules (open-project-governance.md §4); known to owners and admins. */
  rulesPage: boolean | undefined;
  onTogglePublished: () => void; onToggleSuggestOnly: () => void; onToggleRulesPage: () => void; onCopyLink: () => void;
}) {
  return (
    <CenteredDialogShell open={open} busy={false} labelledBy="page-share-title" onCancel={onClose}
      panelClassName="max-w-md">
      <DialogPanelHeader labelledBy="page-share-title" title="Share this page" />
      <div className="space-y-2 px-5 py-4">
        {canPublish && (
          <Toggle label="Anyone with the link can read this page" checked={published}
            disabled={!published && restricted} onChange={onTogglePublished}>
            {!published && restricted ? "A restricted page stays private."
              : "People without an account read it too, with who is on it now."}
          </Toggle>
        )}
        {published && publicUrl && (
          <a className="block px-1 text-xs underline" href={publicUrl} target="_blank" rel="noreferrer">
            Open the public page
          </a>
        )}
        {canEdit && suggestOnly !== undefined && (
          <Toggle label="Agents suggest; a person accepts" checked={suggestOnly} onChange={onToggleSuggestOnly}>
            An Agent&apos;s edit becomes a suggestion in History instead of changing the text.
          </Toggle>
        )}
        {canPublish && rulesPage !== undefined && (
          <Toggle label="Space rules: only owners and admins edit this page" checked={rulesPage} onChange={onToggleRulesPage}>
            Every Agent in this Space reads and follows it; participants read it.
          </Toggle>
        )}
      </div>
      <DialogPanelFooter>
        <DialogButton onClick={onCopyLink}>Copy link</DialogButton>
        <DialogButton tone="primary" onClick={onClose}>Done</DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}

/** A dialog around one piece of content, with a Done button. */
export function PageDialog({ open, onClose, title, id, children, wide = false }: {
  open: boolean; onClose: () => void; title: string; id: string; children: ReactNode; wide?: boolean;
}) {
  return (
    <CenteredDialogShell open={open} busy={false} labelledBy={id} onCancel={onClose}
      panelClassName={wide ? "flex max-w-2xl flex-col" : "flex max-w-lg flex-col"}>
      <DialogPanelHeader labelledBy={id} title={title} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      <DialogPanelFooter>
        <DialogButton tone="primary" onClick={onClose}>Done</DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}

/** Every conversation about the page (§4.4), by section, the quiet and resolved ones too. */
export function ConversationList({ conversations, blocks, onOpen, focusBlockId = null, onResolve }: {
  conversations: MarginConversation[];
  blocks: PageDocBlock[];
  onOpen: (conversationId: string) => void;
  /** Opened from a section: its conversations come first. */
  focusBlockId?: string | null;
  /** Resolves an open discussion, for people who edit the page. */
  onResolve?: (linkId: string) => void;
}) {
  const sections = [{ id: "", title: "This page" }, ...blocks.map((block) => ({ id: block.id, title: block.title }))];
  const ordered = focusBlockId === null ? sections
    : [...sections.filter((section) => section.id === focusBlockId), ...sections.filter((section) => section.id !== focusBlockId)];
  const bySection = (blockId: string) => conversations.filter((conversation) => conversation.blockId === blockId)
    .sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(b.activityAt) - Date.parse(a.activityAt));
  if (conversations.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversations are about this page yet. Select text or hover a heading and choose Discuss.</p>;
  }
  return (
    <div className="space-y-4" data-testid="page-conversations">
      {ordered.map((section) => {
        const items = bySection(section.id);
        if (items.length === 0) return null;
        return (
          <section key={section.id || "page"}>
            <h3 className="mb-1 text-xs font-black uppercase tracking-wide text-muted-foreground">{section.title}</h3>
            <ul className="space-y-1">
              {items.map((conversation) => (
                <li key={conversation.conversationId} className="flex items-start gap-1">
                  <button type="button" onClick={() => onOpen(conversation.conversationId)}
                    className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-semibold">{conversation.name ?? "Conversation"}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {conversation.resolved ? "resolved · " : !conversation.live ? "quiet · " : ""}
                        {formatRelativeAge(conversation.activityAt) ?? ""}
                      </span>
                    </span>
                    {conversation.quote && (
                      <span className="block truncate text-xs italic text-muted-foreground">“{conversation.quote}”</span>
                    )}
                    {conversation.lastMessage && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {conversation.lastMessage.label}: <InlineRowPreview text={conversation.lastMessage.bodyPreview} />
                      </span>
                    )}
                    {conversation.agents.length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {conversation.agents.map((agent) => `${agent.name} · ${agentState(agent.status)}`).join(", ")}
                      </span>
                    )}
                  </button>
                  {onResolve && conversation.linkId && (
                    <Button variant="ghost" size="xs" className="mt-1.5 shrink-0" title="Its outcome is in the page"
                      onClick={() => onResolve(conversation.linkId!)}>
                      Resolve
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The page's history as a mode of the page (§7): its revisions, and what the
 * chosen one changed, colored by kind, with the conversation it came from
 * and restore.
 */
const VERSION_KIND: Record<PageRevision["kind"], string> = {
  edit: "", suggestion: "Suggestion", accepted: "Accepted suggestion", restore: "Restored", purge: "Redacted",
};

/** A version's time: the hour within its day's group, the full date at the top of the open version. */
function versionTime(createdAt: string, full: boolean): string {
  const date = new Date(createdAt);
  return full ? date.toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric",
    minute: "2-digit" }) : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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

export function PageHistory({ spaceId, pageId, token, headRevision, canEdit, conversationName, onOpenConversation,
  onPromoted, onClose }: {
  spaceId: string; pageId: string; token: string; headRevision: number; canEdit: boolean;
  conversationName: (conversationId: string) => string | null;
  onOpenConversation: (conversationId: string) => void;
  onPromoted: () => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const history = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "page-history", [spaceId, pageId, headRevision]),
    queryFn: ({ signal }) => pageApi.history(spaceId, pageId, token, signal).then((result) => result.revisions),
  });
  const [preview, setPreview] = useState<{ revision: PageRevision; diff: PageLineDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A revision reads as what it changed from the one it was based on.
  const open = async (revision: PageRevision) => {
    const previous = revision.basedOnRevision ?? (revision.revision > 1 ? revision.revision - 1 : null);
    const [{ page }, before] = await Promise.all([
      pageApi.read(spaceId, pageId, token, revision.revision),
      previous ? pageApi.read(spaceId, pageId, token, previous).then((result) => result.page.body) : Promise.resolve(""),
    ]);
    setPreview({ revision, diff: pageLineDiff(before, page.body) });
  };
  const promote = async (revision: PageRevision) => {
    setError(null);
    try {
      await pageApi.promote(spaceId, pageId, token, revision.revision, headRevision);
      setPreview(null);
      onPromoted();
    } catch (cause) {
      setError(userErrorMessage(cause, "Couldn't apply this revision"));
    }
  };
  // As in Google Docs, the newest version is open when History opens.
  const newest = history.data?.[0];
  useEffect(() => {
    if (newest && !preview) void open(newest);
    // Only the first load picks a version; choosing another is the reader's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest?.revision]);
  const colorOf = (revision: PageRevision) => revision.authors[0] ? pageAuthorColor(revision.authors[0]) : "var(--primary)";
  return (
    <div className="space-y-3" data-testid="page-history">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}><ArrowLeft /> Back to the page</Button>
        <span className="text-sm font-semibold">Version history</span>
      </div>
      {error && <p className={noticeClass("alert", "rounded-md px-3 py-2 text-xs")}>{error}</p>}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_17rem]">
        {preview ? (
          <div className="min-w-0 rounded-md border p-4 md:order-first">
            <div className="mb-3 flex items-center justify-between gap-2 text-sm">
              <span className="font-semibold">{versionTime(preview.revision.createdAt, true)}</span>
              {canEdit && preview.revision.revision !== headRevision && (
                <Button size="xs" onClick={() => void promote(preview.revision)}>
                  {preview.revision.kind === "suggestion" ? "Accept suggestion" : "Restore this version"}
                </Button>
              )}
            </div>
            <div className="text-[13px] leading-relaxed" data-testid="page-revision-diff">
              {preview.diff.map((part, index) => part.kind === "same" ? (
                // Unchanged runs keep a line of context on each side.
                <p key={index} className="whitespace-pre-wrap text-muted-foreground">{
                  part.lines.length > 3 ? `${part.lines[0]}\n…\n${part.lines.at(-1)}` : part.lines.join("\n")}</p>
              ) : part.kind === "added" ? (
                // What the version added, in its author's colour, as Google Docs highlights it.
                <p key={index} className="whitespace-pre-wrap rounded-sm" data-change="added"
                  style={{ backgroundColor: `color-mix(in oklab, ${colorOf(preview.revision)} 18%, transparent)`,
                    boxShadow: `inset 2px 0 0 ${colorOf(preview.revision)}` }}>{part.lines.join("\n")}</p>
              ) : (
                <p key={index} className="whitespace-pre-wrap text-muted-foreground line-through" data-change="removed"
                  style={{ textDecorationColor: colorOf(preview.revision) }}>{part.lines.join("\n")}</p>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground md:order-first">Choose a version to see what it changed.</p>
        )}
        <div className="space-y-3" data-testid="page-versions">
          {versionGroups(history.data ?? []).map(([day, revisions]) => (
            <section key={day}>
              <h3 className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{day}</h3>
              <ul className="space-y-0.5">
                {revisions.map((revision) => (
                  <li key={revision.revision}>
                    <button type="button" onClick={() => void open(revision)}
                      aria-label={`${versionTime(revision.createdAt, false)} by ${
                        revision.authors.map(pageAuthorLabel).join(", ")}`}
                      className={cn("w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                        preview?.revision.revision === revision.revision && "bg-accent")}>
                      <span className="font-semibold">{versionTime(revision.createdAt, false)}</span>
                      {revision.revision === headRevision && (
                        <span className="block text-xs italic text-muted-foreground">Current version</span>
                      )}
                      {revision.kind !== "edit" && (
                        <span className={cn("block text-xs", revision.kind === "suggestion" ? statusInkClass("attention")
                          : "text-muted-foreground")}>{VERSION_KIND[revision.kind]}</span>
                      )}
                      {revision.authors.map((author) => (
                        <span key={`${author.kind}:${author.id}`} className="mt-0.5 flex items-center gap-1.5 text-xs">
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: pageAuthorColor(author) }} />
                          <span className="truncate" title={author.application ? "OAuth application name supplied by its registration" : undefined}>
                            {pageAuthorLabel(author)}
                          </span>
                        </span>
                      ))}
                    </button>
                    {preview?.revision.revision === revision.revision && revision.conversationIds.map((conversationId) =>
                      conversationName(conversationId) && (
                        <button key={conversationId} type="button" onClick={() => onOpenConversation(conversationId)}
                          className="block px-2 pb-1 text-left text-xs text-muted-foreground hover:underline">
                          in {conversationName(conversationId)}
                        </button>
                      ))}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Deletion uses the existing server authority and never recursively removes children. */
export function DeletePageDialog({ open, title, hasChildren, onClose, onDelete }: {
  open: boolean; title: string; hasChildren: boolean; onClose: () => void; onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) setError(null); }, [open]);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try { await onDelete(); }
    catch (cause) { setError(userErrorMessage(cause, "Couldn't delete this page")); }
    finally { setBusy(false); }
  };
  return (
    <CenteredDialogShell open={open} busy={busy} labelledBy="page-delete-title" onCancel={onClose}
      panelClassName="max-w-md">
      <DialogPanelHeader labelledBy="page-delete-title" title="Delete this page?" />
      <div className="space-y-2 px-5 py-4 text-sm">
        <p className="break-words font-semibold">{title}</p>
        <p>{hasChildren ? "Move or delete its child pages first."
          : "This permanently deletes the page and its version history, and stops its automations. Linked conversations are kept."}</p>
        {error && <p role="alert" className={noticeClass("attention")}>{error}</p>}
      </div>
      <DialogPanelFooter>
        <DialogButton disabled={busy} onClick={onClose}>Cancel</DialogButton>
        <DialogButton tone="destructive" busy={busy} disabled={busy || hasChildren}
          onClick={() => void remove()}>Delete page</DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}

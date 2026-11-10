"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ClientDefectAction, FaceOf } from "@xmatrix/protocol";
import type { PageDocBlock } from "@xmatrix/protocol/page-document";
import {
  Bot, Check, ChevronDown, ChevronUp, Globe, Link2, Lock, ShieldCheck, Users, type LucideIcon,
} from "lucide-react";
import {
  CenteredDialogShell, DialogButton, DialogPanelFooter, DialogPanelHeader,
} from "@/components/dashboard/centered-dialog-shell";
import { listenForOverlayDismissal } from "@/components/dashboard/use-overlay-dismiss";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { InlineRowPreview } from "@/components/dashboard/inline-row-preview";
import { Button } from "@/components/ui/button";
import { LiquidGlassCard, LiquidGlassPill } from "@/components/ui/material-surfaces";
import { Switch } from "@/components/ui/switch";
import { noticeClass, statusInkClass } from "@/components/ui/status-tone";
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
export interface PageScrollMark { key: string; fraction: number; top: number; kind: "person" | "discussion";
  color?: string; unread?: number; title: string }

/** The document's conversation distribution and current viewport, with a keyboard-accessible jump per mark. */
export function PageScrollMarks({ marks, viewport, onJump }: { marks: PageScrollMark[];
  viewport: { start: number; size: number }; onJump: (top: number) => void }) {
  if (marks.length === 0) return null;
  return (
    <nav className="pointer-events-none absolute inset-y-8 right-0 z-10 w-4" aria-label="Page positions" data-testid="page-scroll-marks">
      <span aria-hidden="true" className="absolute inset-y-0 right-1.5 w-px bg-foreground/10" />
      <span aria-hidden="true" data-testid="page-scroll-viewport" className="page-scroll-viewport pointer-events-none absolute inset-x-0 rounded-sm"
        style={{ top: `${Math.max(0, Math.min(1, viewport.start)) * 100}%`, height: `${Math.min(1, viewport.size) * 100}%` }} />
      {marks.map((mark) => (
        <button type="button" key={mark.key} title={mark.title} aria-label={mark.title} onClick={() => onJump(mark.top)}
          className="pointer-events-auto absolute right-0 flex h-4 w-4 -translate-y-1/2 items-center justify-end rounded-sm hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-primary"
          style={{ top: `clamp(8px, ${Math.min(1, Math.max(0, mark.fraction)) * 100}%, calc(100% - 8px))` }}>
          <span className={cn("h-0.5 w-2 rounded-l-sm", mark.unread ? "bg-destructive"
            : mark.kind === "discussion" && "page-scroll-mark-discussion")}
            style={mark.kind === "person" && mark.color ? { backgroundColor: mark.color } : undefined} />
        </button>
      ))}
    </nav>
  );
}

/** One setting in Share: what it does, said plainly, and the control that does it at the row's end. */
function ShareRow({ icon: Icon, title, detail, children }: {
  icon: LucideIcon; title: string; detail: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span aria-hidden="true" className="page-share-icon flex size-8 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12px] text-muted-foreground">{detail}</span>
      </span>
      {children}
    </div>
  );
}

/** A setting's switch, held off while its change is on its way. */
function ShareSwitch({ label, checked, disabled, failure, onChange }: {
  label: string; checked: boolean; disabled?: boolean;
  /** What the reader is told when the change does not go through. */
  failure: ClientDefectAction; onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = () => {
    setBusy(true);
    setError(null);
    onChange().catch((cause: unknown) => setError(userErrorMessage(cause, failure)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex shrink-0 flex-col items-end">
      <Switch label={label} checked={checked} disabled={disabled || busy} onChange={change} />
      {error && <span role="alert" className={cn("mt-1 max-w-40 text-right text-[11px]", statusInkClass("alert"))}>{error}</span>}
    </span>
  );
}

/** Copies a link and says so on the button itself, where the reader is looking. */
function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <DialogButton className={className} icon={copied ? Check : Link2}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
      {copied ? "Copied" : label}
    </DialogButton>
  );
}

/** Where the Share panel stands: under its button, its right edge on the button's, inside the window. */
function sharePanelPlace(anchor: HTMLElement | null): CSSProperties | null {
  if (!anchor) return null;
  const box = anchor.getBoundingClientRect();
  const width = Math.min(SHARE_PANEL_WIDTH, window.innerWidth - 2 * SHARE_PANEL_EDGE);
  const left = Math.max(SHARE_PANEL_EDGE, Math.min(box.right - width, window.innerWidth - width - SHARE_PANEL_EDGE));
  return { top: box.bottom + 8, left, width };
}
const SHARE_PANEL_WIDTH = 400;
const SHARE_PANEL_EDGE = 12;

/**
 * Share (pages-live-document.md §7) answers two questions: who reads the page, and how it is changed. Each
 * link stands beside the people it opens for: the page's own link for the Space, the public one for anyone.
 * It drops from its button as one glass pane, as search does, and every change takes effect as it is switched.
 */
export function ShareDialog({ open, anchor, onClose, canPublish, canEdit, published, restricted, members, pageLink,
  publicUrl, suggestOnly, rulesPage, onTogglePublished, onToggleSuggestOnly, onToggleRulesPage }: {
  open: boolean;
  /** The Share button the panel drops from. */
  anchor: HTMLElement | null;
  onClose: () => void;
  canPublish: boolean; canEdit: boolean; published: boolean; restricted: boolean;
  /** How many people are in the Space, who all read an open page. */
  members: number;
  /** The page in the app, for the people in the Space. */
  pageLink: string;
  /** The page anyone can read, once it is published. */
  publicUrl: string | null;
  suggestOnly: boolean | undefined;
  /** Whether this page states the project's rules (open-project-governance.md §4); known to owners and admins. */
  rulesPage: boolean | undefined;
  onTogglePublished: () => Promise<void>; onToggleSuggestOnly: () => Promise<void>; onToggleRulesPage: () => Promise<void>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setPlace(sharePanelPlace(anchor));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor, open]);
  useEffect(() => open ? listenForOverlayDismissal((event) => {
    const where = event.target instanceof Node ? event.target : null;
    // The button toggles the panel itself.
    if (where && (panel.current?.contains(where) || anchor?.contains(where))) return;
    onClose();
  }, onClose) : undefined, [anchor, onClose, open]);
  if (!open || typeof document === "undefined") return null;
  const publicLink = publicUrl && typeof window !== "undefined" ? `${window.location.origin}${publicUrl}` : null;
  const editing = (canEdit && suggestOnly !== undefined) || (canPublish && rulesPage !== undefined);
  return createPortal(
    <div ref={panel} className={cn("xmatrix-app fixed z-[var(--z-popover)]", !place && "invisible")}
      style={place ?? undefined}>
      <LiquidGlassCard role="dialog" aria-labelledby="page-share-title" data-testid="page-share"
        className="app-dialog-panel page-share-panel px-4 pb-3 pt-3 text-foreground">
        <h2 id="page-share-title" className="sr-only">Share this page</h2>
        <p className="page-share-heading">Who can read</p>
        <ShareRow icon={restricted ? Lock : Users} title={restricted ? "Only people given access" : "Everyone in this Space"}
          detail={restricted ? "This page or one above it is restricted."
            : `${members === 1 ? "1 person" : `${members} people`} and their Agents`}>
          <CopyButton text={pageLink} label="Copy link" className="h-8 min-w-0 px-3 text-[13px]" />
        </ShareRow>
        {canPublish && (
          <ShareRow icon={Globe} title="Anyone with the link"
            detail={!published && restricted ? "A restricted page stays in the Space." : "Read-only, no account needed"}>
            <ShareSwitch label="Anyone with the link can read this page" checked={published}
              disabled={!published && restricted} failure="Couldn't change who can read this page"
              onChange={onTogglePublished} />
          </ShareRow>
        )}
        {published && publicLink && (
          <div className="page-share-link mb-1 flex items-center gap-2 rounded-full py-1 pl-3.5 pr-1">
            <a href={publicLink} target="_blank" rel="noreferrer" title="Open the public page"
              className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground hover:text-foreground hover:underline">
              {publicLink.replace(/^https?:\/\//u, "")}
            </a>
            <CopyButton text={publicLink} label="Copy" className="h-7 min-w-0 px-2.5 text-[12px]" />
          </div>
        )}
        {editing && <p className="page-share-heading mt-2">Who changes it</p>}
        {canEdit && suggestOnly !== undefined && (
          <ShareRow icon={Bot} title="Agents only suggest" detail="A person accepts each change in History.">
            <ShareSwitch label="Agents suggest; a person accepts" checked={suggestOnly}
              failure="Couldn't change who edits this page" onChange={onToggleSuggestOnly} />
          </ShareRow>
        )}
        {canPublish && rulesPage !== undefined && (
          <ShareRow icon={ShieldCheck} title="Space rules"
            detail="Only owners and admins edit it; every Agent in the Space follows it.">
            <ShareSwitch label="Space rules: only owners and admins edit this page" checked={rulesPage}
              failure="Couldn't change who edits this page" onChange={onToggleRulesPage} />
          </ShareRow>
        )}
      </LiquidGlassCard>
    </div>,
    document.body
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
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const filtered = conversations.filter((item) => filter === "all" || (filter === "resolved" ? item.resolved : !item.resolved));
  const sections = [{ id: "", title: "This page" }, ...blocks.map((block) => ({ id: block.id, title: block.title }))];
  const ordered = focusBlockId === null ? sections
    : [...sections.filter((section) => section.id === focusBlockId), ...sections.filter((section) => section.id !== focusBlockId)];
  const bySection = (blockId: string) => filtered.filter((conversation) => conversation.blockId === blockId)
    .sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(b.activityAt) - Date.parse(a.activityAt));
  if (conversations.length === 0) {
    return <p className="text-sm text-muted-foreground">No conversations are about this page yet. Select text or hover a heading and choose Discuss.</p>;
  }
  return (
    <div className="space-y-4" data-testid="page-conversations">
      <div className="flex gap-1" role="group" aria-label="Filter conversations">
        {(["all", "open", "resolved"] as const).map((value) => (
          <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"}
            aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === "all" ? "All" : value === "open" ? "Open" : "Resolved"}
          </Button>
        ))}
      </div>
      {filtered.length === 0 && <p className="text-sm text-muted-foreground">No {filter} conversations.</p>}
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

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Maximize2, PenLine, X } from "lucide-react";
import type { FaceOf } from "@xmatrix/protocol";
import { Face } from "@/components/dashboard/face";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { cn } from "@/lib/utils";
import { sameValue } from "@/lib/same-value";
import { anchorTop, layoutMargin, type MarginConversation } from "./page-margin-model";
import type { PresentPerson } from "./page-chrome";
import { CardPen, MarginPen } from "./page-pen";
import { discussionTitle } from "@/components/dashboard/selection-discussion";
import { InlineRowPreview } from "@/components/dashboard/inline-row-preview";

/** A card's height before it is measured. */
const ESTIMATED_CARD_HEIGHT = 76;
/** Room the card at the margin's top or bottom edge covers: what is under it counts as out of view. */
const EDGE_ROOM = 48;
/** Marks what the margin draws, so a paragraph's writers show beside it only where nothing stands. */
export const MARGIN_ITEM = "[data-page-margin-item]";
/** An Agent's pill and the line under it, before they are measured. */
const ESTIMATED_WRITER_HEIGHT = 56;
/** How far above its line an Agent's pill stands, so the pill is level with the line, as at the right edge. */
const WRITER_RISE = 3;

/** An Agent at work on the page, in the margin beside its line, with the channel it works for (§4.4). */
export interface MarginWriter {
  key: string;
  person: PresentPerson;
  /** Its caret's line where it has one, else its section. */
  anchor: string;
  /** Its channel as the page lists it, or null when the page does not link it. */
  conversation: MarginConversation | null;
  /** Its channel's name, for one the page does not link. */
  channel: string | null;
}

/** How an Agent's state reads on a card: working on a turn, or there and idle. */
export function agentState(status: MarginConversation["agents"][number]["status"]): string {
  return status === "busy" ? "Working" : "Idle";
}

/**
 * A conversation's name as its card says it. A co-writing conversation is named after the page it was started
 * on; beside that page the title says nothing, and goes stale when the page is renamed, so only its section stays.
 */
function cardName(name: string | null): string {
  if (!name) return "Conversation";
  if (!name.startsWith("Co-writing ")) return name;
  const section = name.lastIndexOf(" › ");
  return section >= 0 ? `Co-writing › ${name.slice(section + 3)}` : "Co-writing";
}

/** A conversation about the page is a comment, as in Google Docs: its icon starts its card and its line. */
function CommentIcon() {
  return (
    <svg className="page-comment-icon" width="16" height="14" viewBox="0 0 34 30" aria-hidden="true">
      <path d="M6 2h22a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H14l-6 5v-5H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4z" />
    </svg>
  );
}

/**
 * What a card is about, after the comment icon: a discussion's passage, or the conversation's name. The icon
 * takes the avatars' column, so the words start where the names under them do. An open card has room for
 * more of the passage.
 */
function CardContext({ conversation, open = false }: { conversation: MarginConversation; open?: boolean }) {
  return (
    <span className={cn("flex min-w-0 gap-2", open ? "items-start" : "items-center")}>
      <span className="grid h-5 w-6 shrink-0 place-items-center"><CommentIcon /></span>
      {conversation.quote ? (
        <span className={cn("text-[12px] leading-5 text-muted-foreground", open ? "line-clamp-3 [overflow-wrap:anywhere]" : "truncate")}>
          “{conversation.quote}”
        </span>
      ) : (
        <span className="truncate text-[13px] font-semibold leading-5 text-foreground">{cardName(conversation.name)}</span>
      )}
    </span>
  );
}

/**
 * The Agents in it, as a comment thread shows who is typing: each its Instance card from the conversation at a
 * comment's size, on paper. Its vendor's face and its name; its status dot says whether it works, and one at work
 * runs its dots, as its pill on the page does.
 */
export function WorkingLine({ agents, className }: { agents: ReadonlyArray<Pick<MarginConversation["agents"][number],
  "instanceId" | "name" | "status" | "face">>; className?: string }) {
  const working = agents.filter((agent) => agent.status === "busy");
  const shown = working.length > 0 ? working : agents;
  if (shown.length === 0) return null;
  return (
    <span className={cn("page-margin-working flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      {shown.map((agent) => (
        <span key={agent.instanceId} className="page-margin-instance" data-status={agent.status}
          title={`${agent.name} · ${agentState(agent.status)}`}>
          <Face of={agent.face} status={agent.status} size="xs" shape="circle" glass={false}
            className="page-margin-instance-face" />
          <span className="page-margin-instance-name">{agent.name}</span>
          {agent.status === "busy" && <span className="page-writer-dots" aria-hidden="true"><i /><i /><i /></span>}
        </span>
      ))}
    </span>
  );
}

function UnreadBadge({ unread, className }: { unread: number; className?: string }) {
  if (unread <= 0) return null;
  return (
    <span className={cn("shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-bold leading-4 text-primary-foreground", className)}
      aria-label={`${unread} unread`}>
      {unread}
    </span>
  );
}

function ConversationCard({ conversation, writer, focused, canResolve, onOpen, onResolve, onFocus }: {
  conversation: MarginConversation;
  /** Its Agent at work on its own passage, whose pill the card holds in place of its working line. */
  writer?: MarginWriter | undefined;
  focused: boolean;
  canResolve: boolean;
  onOpen: () => void;
  onResolve: () => void;
  onFocus: (focused: boolean) => void;
}) {
  const { lastMessage, agents, unread } = conversation;
  return (
    // As on a Channel row, resting on the card reads the conversation ahead of its opening.
    <div className="group relative" onMouseEnter={() => onFocus(true)} onMouseLeave={() => onFocus(false)}
      data-channel-row-id={conversation.conversationId}>
      <button type="button" onClick={onOpen} data-testid="page-margin-card"
        aria-label={`Open ${conversation.name ?? "the conversation"} beside the page`}
        className={cn("page-margin-card block w-full rounded-xl px-3 py-2.5 text-left transition-[background-color,box-shadow]",
          focused && "page-margin-card-focused")}>
        <span className="flex items-start gap-2 pr-5">
          <span className="min-w-0 flex-1"><CardContext conversation={conversation} /></span>
          <UnreadBadge unread={unread} className="mt-0.5" />
        </span>
        {lastMessage ? (
          <span className="mt-2 flex gap-2">
            <Face of={lastMessage.face} size="xs" shape="circle" className="mt-px" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-[13px] font-semibold text-foreground">{lastMessage.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelativeAge(lastMessage.sentAt) ?? ""}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-[13px] leading-[1.4] text-foreground/85"><InlineRowPreview text={lastMessage.bodyPreview} /></span>
            </span>
          </span>
        ) : agents.length === 0 && (
          <span className="mt-1 block text-[12px] text-muted-foreground">
            {formatRelativeAge(conversation.activityAt) ?? ""}
          </span>
        )}
        {writer ? <span className="mt-2 block"><CardPen person={writer.person} /></span>
          : <WorkingLine agents={agents} className="mt-2" />}
      </button>
      {canResolve && conversation.linkId && (
        <button type="button" onClick={onResolve} title="Resolve: its outcome is in the page"
          aria-label="Resolve the discussion"
          className="absolute top-2 right-2 hidden size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground group-hover:flex">
          <Check className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** The tallest an open thread grows before its messages scroll. */
const OPEN_MAX_HEIGHT = "min(34rem, calc(100dvh - 8rem))";
/** The least an open thread shrinks to near the page's end; with less room than this, it rises instead. */
const OPEN_MIN_ROOM = 192;
/** Room between an empty thread's note and its composer. */
const EMPTY_THREAD_GAP = 12;

const threadAction = "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

/**
 * The open conversation, as a selected comment thread in Google Docs: raised
 * above the other cards and nudged toward the text, with what it is about,
 * then the conversation itself, sized to what it says.
 */
function OpenConversationCard({ conversation, quietAgents = false, room = null, canResolve, children, onResolve, onExpand, onClose,
  onFocus }: {
  conversation: MarginConversation;
  /** The room left down to the page's end: the thread is no taller, and its messages scroll inside it. */
  room?: number | null;
  /** Opened from an Agent's pill, which already says who works in it. */
  quietAgents?: boolean;
  canResolve: boolean;
  children: ReactNode;
  onResolve: () => void;
  onExpand?: () => void;
  onClose?: () => void;
  onFocus: (focused: boolean) => void;
}) {
  const headerRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  // A thread is as tall as what it says, up to a cap. The message list scrolls
  // inside a box of known height, so the card adds up the list's rows (its
  // header, messages and footer) and sets its own height from them. A thread
  // with nothing in it yet is its header and its composer, and any note the
  // empty conversation still shows, such as why it could not load.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let list: Element | null = null;
    let empty: Element | null = null;
    let composer: HTMLElement | null = null;
    const measure = () => {
      const header = headerRef.current?.offsetHeight ?? 0;
      const rows = list ? [...list.children].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) : 0;
      const bottom = empty ? Math.max(0, ...[...empty.children].map((child) => child.getBoundingClientRect().bottom)) : 0;
      const note = empty && bottom > 0 ? bottom - empty.getBoundingClientRect().top : 0;
      const next = rows > 0 ? Math.ceil(header + rows)
        : empty && composer ? Math.ceil(header + (note > 0 ? note + EMPTY_THREAD_GAP : 0) + composer.offsetHeight) : null;
      setHeight((current) => current === next ? current : next);
    };
    const sizes = new ResizeObserver(measure);
    const attach = () => {
      const viewport = body.querySelector(".app-message-timeline > div > div");
      const found = viewport?.querySelector(":scope > [data-timeline-rise-content]") ?? viewport;
      const foundEmpty = body.querySelector(".app-empty-conversation");
      const foundComposer = body.querySelector<HTMLElement>(".app-composer");
      if (found !== list || foundEmpty !== empty || foundComposer !== composer) {
        list = found;
        empty = foundEmpty;
        composer = foundComposer;
        sizes.disconnect();
      }
      if (list) for (const row of list.children) sizes.observe(row);
      if (empty) sizes.observe(empty);
      if (composer) sizes.observe(composer);
      measure();
    };
    attach();
    const changes = new MutationObserver(attach);
    changes.observe(body, { childList: true, subtree: true });
    return () => { changes.disconnect(); sizes.disconnect(); };
  }, []);
  return (
    <section data-testid="page-margin-open" aria-label={conversation.name ?? "Conversation"}
      onMouseEnter={() => onFocus(true)} onMouseLeave={() => onFocus(false)}
      onKeyDown={(event) => { if (event.key === "Escape" && onClose) onClose(); }}
      style={{ height: `min(${[height && `${height}px`, room !== null && `${room}px`, OPEN_MAX_HEIGHT].filter(Boolean).join(", ")})` }}
      className="page-margin-open flex min-h-0 flex-col overflow-hidden rounded-xl">
      <header ref={headerRef} className="flex shrink-0 items-start gap-1 pt-2.5 pr-2 pl-3">
        <span className="min-w-0 flex-1 pt-1">
          <CardContext conversation={conversation} open />
          {/* A discussion is named by its passage until its content names it otherwise. */}
          {conversation.quote && conversation.name && conversation.name !== discussionTitle(conversation.quote) && (
            <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{conversation.name}</span>
          )}
          {!quietAgents && <WorkingLine agents={conversation.agents} className="mt-1" />}
        </span>
        {canResolve && conversation.linkId && (
          <button type="button" onClick={onResolve} title="Resolve: its outcome is in the page"
            aria-label="Resolve the discussion" className={threadAction}>
            <Check className="size-4" />
          </button>
        )}
        {onExpand && (
          <button type="button" onClick={onExpand} title="Open in Conversations" aria-label="Open in Conversations"
            className={threadAction}>
            <Maximize2 className="size-3.5" />
          </button>
        )}
        {onClose && (
          <button type="button" onClick={onClose} title="Close" aria-label="Close the conversation" className={threadAction}>
            <X className="size-4" />
          </button>
        )}
      </header>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/**
 * An Agent at work, beside the line it writes (§4.4): its pill, and under it the channel it works for, the comment
 * icon under its face and the words under its name. Opened, the channel is the conversation itself, right under
 * the pill on the same left edge; what may be done to the Agent stands beside the pill then.
 */
function WriterUnit({ writer, open, actions, onPress, children }: {
  writer: MarginWriter;
  open: boolean;
  actions: ReactNode;
  onPress: () => void;
  /** The open conversation, under the pill. */
  children?: ReactNode;
}) {
  const name = writer.conversation?.name ?? writer.channel;
  const last = writer.conversation?.lastMessage ?? null;
  return (
    <div data-testid="page-margin-writer">
      <div className="flex items-center gap-2">
        <MarginPen person={writer.person} open={open} onPress={onPress} />
        {open && actions}
      </div>
      {open ? children : (name || last) && (
        <button type="button" onClick={onPress} className="page-margin-writer-channel"
          aria-label={`Open ${name ?? "the conversation"} beside the page`}>
          <CommentIcon />
          <span className="min-w-0 truncate">
            <span className="font-semibold text-foreground">{cardName(name)}</span>
            {last && <span className="text-muted-foreground"> · {last.label}: <InlineRowPreview text={last.bodyPreview} /></span>}
          </span>
        </button>
      )}
    </div>
  );
}

/** Something beside the page that is out of view: a conversation's card, an Agent at work, or someone editing. */
export interface OffscreenEntry {
  key: string;
  /** Where it is, in the coordinates the card's jump takes. */
  top: number;
  conversation?: MarginConversation | null;
  person?: PresentPerson;
}

/**
 * What is beside the page above or below what the reader sees (§3.2, §4.4), told as the margin tells it: the
 * conversations out of view by their comment icon, and who works or edits there as a card's working line says
 * it. Only what the margin draws and who is editing count; someone only reading, or an Agent at rest, is not
 * work to scroll to. A press goes to the nearest.
 */
export function PageOffscreenCard({ side, entries, onJump }: {
  side: "above" | "below"; entries: readonly OffscreenEntry[]; onJump: (top: number) => void;
}) {
  if (entries.length === 0) return null;
  const nearest = entries.reduce((best, entry) => (side === "above" ? entry.top > best.top : entry.top < best.top) ? entry : best);
  const conversations = [...new Map(entries.flatMap((entry) => entry.conversation
    ? [[entry.conversation.conversationId, entry.conversation] as const] : [])).values()];
  const unread = conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
  // Each Agent at work once, by name, with its face.
  const working = [...new Map<string, FaceOf>([
    ...entries.flatMap((entry) => entry.person?.agent ? [[entry.person.name, entry.person.face] as const] : []),
    ...conversations.flatMap((conversation) => conversation.agents.filter((agent) => agent.status === "busy")
      .map((agent) => [agent.name, agent.face] as const)),
  ])];
  const editing = [...new Set(entries.flatMap((entry) => entry.person && !entry.person.agent ? [entry.person.name] : []))];
  const said = [
    conversations.length > 0 ? `${conversations.length} ${conversations.length === 1 ? "conversation" : "conversations"}` : null,
    working.length > 0 ? `${working.map(([name]) => name).join(", ")} working` : null,
    editing.length > 0 ? `${editing.join(", ")} editing` : null,
  ].filter(Boolean).join(", ");
  const Arrow = side === "above" ? ArrowUp : ArrowDown;
  return (
    <button type="button" onClick={() => onJump(nearest.top)} data-testid={`page-offscreen-${side}`}
      aria-label={`${said} ${side}`}
      className="page-margin-card page-margin-edge pointer-events-auto flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {conversations.length > 0 && (
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid h-5 w-6 shrink-0 place-items-center"><CommentIcon /></span>
            <span className="truncate text-[13px] font-semibold leading-5 text-foreground">
              {conversations.length} {conversations.length === 1 ? "conversation" : "conversations"} {side}
            </span>
            <UnreadBadge unread={unread} />
          </span>
        )}
        <WorkingLine agents={working.map(([name, face]) => ({ instanceId: name, name, status: "busy" as const, face }))} />
        {editing.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            <PenLine className="size-3 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{editing.join(", ")} · Editing</span>
          </span>
        )}
      </span>
      <Arrow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * The page's margin (pages-live-document.md §4.4): each live conversation
 * beside what it is about, as comments are in Google Docs. `tops` are the
 * anchors' offsets from the top of the document, which the margin shares.
 * The open conversation expands in its card's place, level with its anchor,
 * and the other cards make room above and below it.
 */
/** The margin's head, kept apart from conversation and Agent ids. */
const HEAD = "head:";

export function PageMargin({ conversations, writers = [], editors = [], view = null, end = null, tops, focusedId, openId = null,
  renderOpen, canResolve, onOpen, onResolve, onExpand, onClose, onFocus, onJump, onWriter, writerActions, head }: {
  conversations: MarginConversation[];
  /** What stands at the top of the margin, above the cards it would otherwise cover. */
  head?: ReactNode;
  /** The Agents at work on the page. Each stands beside its line, and its channel's card is not drawn again. */
  writers?: readonly MarginWriter[];
  /** People editing the page, at their caret's line: out of view, they are told at the margin's edges with what it holds. */
  editors?: ReadonlyArray<{ person: PresentPerson; top: number }>;
  /** The part of the margin in view, in its own coordinates; null before the page is laid out. */
  view?: { top: number; height: number } | null;
  /** Where the page would end without the margin, in its coordinates: the cards rise to stay above it. */
  end?: number | null;
  tops: ReadonlyMap<string, number>;
  focusedId: string | null;
  /** The conversation open in the margin, and the conversation itself to show there. */
  openId?: string | null;
  renderOpen?: () => ReactNode;
  canResolve: boolean;
  onOpen: (conversationId: string) => void;
  onResolve: (linkId: string) => void;
  /** Gives the open conversation the whole window, or closes it. */
  onExpand?: (conversationId: string) => void;
  onClose?: () => void;
  /** The card being read, so its passage is marked in the text. */
  onFocus: (conversationId: string | null) => void;
  /** Scrolls the page to a place in the margin, from the card at its edge. */
  onJump?: (top: number) => void;
  /** An Agent pressed whose channel the page cannot open beside it. */
  onWriter?: (writer: MarginWriter) => void;
  /** What may be done to an Agent whose channel is open. */
  writerActions?: (person: PresentPerson) => ReactNode;
}) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  // A discussion stays beside the passage it was started on, which is where its reader opens it; its Agent at work
  // stands at its own line without taking the conversation there.
  const atPassage = (writer: MarginWriter) => writer.conversation?.anchor.startsWith("text:") ?? false;
  // An Agent writing its discussion's own passage is at work in the card there: one place, not a pill above a card.
  const writerTop = (writer: MarginWriter) =>
    tops.get(writer.anchor) ?? anchorTop(tops, { anchor: writer.anchor, blockId: writer.person.blockId });
  const inCard = new Map(writers.filter((writer) => writer.conversation && atPassage(writer)
    && Math.abs(writerTop(writer) - anchorTop(tops, writer.conversation)) < 120)
    .map((writer) => [writer.conversation!.conversationId, writer]));
  const pens = writers.filter((writer) => !inCard.has(writer.conversation?.conversationId ?? ""));
  const holding = writers.filter((writer) => writer.conversation && !atPassage(writer));
  const withWriters = new Set(holding.map((writer) => writer.conversation!.conversationId));
  const cards = conversations.filter((conversation) => conversation.live && !withWriters.has(conversation.conversationId));
  // A channel open beside the page opens under the first of its Agents at work, or in its card's place.
  const holder = openId ? holding.find((writer) => writer.conversation?.conversationId === openId) ?? null : null;
  const writerId = (writer: MarginWriter) => `writer:${writer.key}`;
  const items = [
    ...(head ? [{ id: HEAD, top: 0, estimate: ESTIMATED_CARD_HEIGHT }] : []),
    ...cards.map((card) => ({ id: card.conversationId, top: anchorTop(tops, card), estimate: ESTIMATED_CARD_HEIGHT })),
    ...pens.map((writer) => ({ id: writerId(writer), estimate: ESTIMATED_WRITER_HEIGHT, top: writerTop(writer) - WRITER_RISE })),
  ];
  const openItem = holder ? writerId(holder) : openId;
  const cardKey = items.map((item) => item.id).join("\u0000");

  // Cards grow with their content; each measured height moves the ones after it.
  useLayoutEffect(() => {
    const measure = () => setHeights((current) => {
      const next = new Map<string, number>();
      for (const [id, node] of nodes.current) next.set(id, node.offsetHeight);
      return sameValue(current, next) ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of nodes.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [cardKey]);

  // Opened from elsewhere (a cursor label, a heading), the conversation scrolls into view where it sits, once as it
  // opens: its Agent going busy or idle, or its live session coming and going, moves it between the Agent's pill and
  // its card, and that must not take the reader there again.
  const openedItem = useRef(openItem);
  openedItem.current = openItem;
  useEffect(() => {
    if (!openId) return;
    const frame = window.requestAnimationFrame(() => {
      const item = openedItem.current;
      if (item) nodes.current.get(item)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openId]);

  // The margin fits the page and never lengthens it. Near the page's end, an open thread stays at its passage, only
  // as tall as the room left under it, its messages scrolling inside; with too little room, it rises.
  const openRoom = ((): number | null => {
    const opened = items.find((item) => item.id === openItem);
    if (end === null || !opened) return null;
    return Math.max(OPEN_MIN_ROOM, end - opened.top - (holder ? ESTIMATED_WRITER_HEIGHT : 0));
  })();
  // Only the open conversation moves the column. A hovered card only lights up:
  // moving it would slide another card under the pointer, which then moves in turn.
  // A card with no place beside the open one waits, unseen but measured, until it closes.
  const positions = layoutMargin(items.map((item) => ({ id: item.id, top: item.top,
    height: heights.get(item.id) ?? item.estimate })), openItem, end);
  const shown = items.filter((item) => positions.has(item.id));
  const bottom = Math.max(0, ...shown.map((item) => positions.get(item.id)! + (heights.get(item.id) ?? item.estimate)));
  const openCard = (conversation: MarginConversation, quietAgents: boolean) => renderOpen && (
    <OpenConversationCard conversation={conversation} quietAgents={quietAgents} room={openRoom} canResolve={canResolve}
      onResolve={() => conversation.linkId && onResolve(conversation.linkId)}
      {...(onExpand ? { onExpand: () => onExpand(conversation.conversationId) } : {})}
      {...(onClose ? { onClose } : {})}
      onFocus={(focused) => onFocus(focused ? conversation.conversationId : null)}>
      {renderOpen()}
    </OpenConversationCard>
  );
  const place = (id: string, child: ReactNode) => (
    <div key={id} className={cn("absolute inset-x-0 transition-[top] duration-150", !positions.has(id) && "invisible")}
      style={{ top: positions.get(id) ?? 0 }} data-page-margin-item={positions.has(id) ? "" : undefined}
      ref={(node) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }}>
      {child}
    </div>
  );

  // What the margin holds out of view, at its top and bottom edges, by where each card and pill is drawn.
  const offscreen = ((): { above: OffscreenEntry[]; below: OffscreenEntry[] } => {
    const above: OffscreenEntry[] = [];
    const below: OffscreenEntry[] = [];
    if (!view || !onJump) return { above, below };
    const sort = (entry: OffscreenEntry, height: number) => {
      if (entry.top + height < view.top + EDGE_ROOM / 2) above.push(entry);
      else if (entry.top > view.top + view.height - EDGE_ROOM) below.push(entry);
    };
    for (const item of shown) {
      if (item.id === HEAD) continue;
      const top = positions.get(item.id)!;
      const height = heights.get(item.id) ?? item.estimate;
      const card = cards.find((conversation) => conversation.conversationId === item.id);
      const writer = card ? null : writers.find((entry) => writerId(entry) === item.id);
      sort(card ? { key: item.id, top, conversation: card }
        : { key: item.id, top, person: writer!.person,
          conversation: atPassage(writer!) ? null : writer!.conversation }, height);
    }
    for (const { person, top } of editors) sort({ key: person.key, top, person }, 0);
    return { above, below };
  })();

  return (
    <>
      {view && onJump && (
        // Held in view while the page scrolls under it, the height of what is seen, so its cards stand at the edges.
        <div className="pointer-events-none sticky top-0 z-20 h-0">
          <div className="relative" style={{ height: view.height }}>
            {offscreen.above.length > 0 && (
              <div className="absolute inset-x-0 top-2" data-page-margin-item=""><PageOffscreenCard side="above" entries={offscreen.above} onJump={onJump} /></div>
            )}
            {offscreen.below.length > 0 && (
              <div className="absolute inset-x-0 bottom-3" data-page-margin-item=""><PageOffscreenCard side="below" entries={offscreen.below} onJump={onJump} /></div>
            )}
          </div>
        </div>
      )}
      <div className="relative" style={{ minHeight: bottom }} data-testid="page-margin" aria-label="Conversations on this page">
        {head && place(HEAD, head)}
        {cards.map((card) => place(card.conversationId, card.conversationId === openId && renderOpen ? openCard(card, false) : (
          <ConversationCard conversation={card} writer={inCard.get(card.conversationId)}
            focused={card.conversationId === focusedId} canResolve={canResolve}
            onOpen={() => onOpen(card.conversationId)}
            onResolve={() => card.linkId && onResolve(card.linkId)}
            onFocus={(focused) => onFocus(focused ? card.conversationId : null)} />
        )))}
        {pens.map((writer) => {
          const conversation = writer.conversation;
          const open = Boolean(conversation && writer === holder && renderOpen);
          if (conversation && atPassage(writer)) {
            // Its discussion's card says the channel at the passage; the pill opens it there.
            return place(writerId(writer), (
              <WriterUnit writer={{ ...writer, conversation: null, channel: null }} open={false} actions={null}
                onPress={() => conversation.conversationId === openId ? onClose?.() : onOpen(conversation.conversationId)} />
            ));
          }
          return place(writerId(writer), (
            <WriterUnit writer={writer} open={open} actions={writerActions?.(writer.person) ?? null}
              onPress={() => {
                if (open) onClose?.();
                else if (conversation) onOpen(conversation.conversationId);
                else onWriter?.(writer);
              }}>
              {open && conversation && <div className="mt-2">{openCard(conversation, true)}</div>}
            </WriterUnit>
          ));
        })}
      </div>
    </>
  );
}

"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Maximize2, Sparkles, X } from "lucide-react";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { cn } from "@/lib/utils";
import { sameValue } from "@/lib/same-value";
import { anchorTop, layoutMargin, type MarginConversation } from "./page-margin-model";
import type { PresentPerson } from "./page-chrome";
import { MarginPen } from "./page-pen";
import { discussionTitle } from "@/components/dashboard/selection-discussion";

/** A card's height before it is measured. */
const ESTIMATED_CARD_HEIGHT = 76;
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

/** The Agents working in it, as a comment thread shows who is typing. */
function WorkingLine({ agents, className }: { agents: MarginConversation["agents"]; className?: string }) {
  const working = agents.filter((agent) => agent.status === "busy");
  const shown = working.length > 0 ? working : agents;
  if (shown.length === 0) return null;
  return (
    <span className={cn("page-margin-working flex items-center gap-1.5 text-[12px] text-muted-foreground", className)}>
      <AnimatedIcon icon={Sparkles} className={cn("size-3 shrink-0", working.length > 0 && "animate-pulse text-primary")} />
      <span className="truncate">
        {shown.map((agent) => agent.name).join(", ")} · {agentState(shown[0]!.status)}
      </span>
    </span>
  );
}

function ConversationCard({ conversation, focused, canResolve, onOpen, onResolve, onFocus }: {
  conversation: MarginConversation;
  focused: boolean;
  canResolve: boolean;
  onOpen: () => void;
  onResolve: () => void;
  onFocus: (focused: boolean) => void;
}) {
  const { lastMessage, agents, unread } = conversation;
  return (
    <div className="group relative" onMouseEnter={() => onFocus(true)} onMouseLeave={() => onFocus(false)}>
      <button type="button" onClick={onOpen} data-testid="page-margin-card"
        aria-label={`Open ${conversation.name ?? "the conversation"} beside the page`}
        className={cn("page-margin-card block w-full rounded-xl px-3 py-2.5 text-left transition-[background-color,box-shadow]",
          focused && "page-margin-card-focused")}>
        <span className="flex items-start gap-2 pr-5">
          <span className="min-w-0 flex-1"><CardContext conversation={conversation} /></span>
          {unread > 0 && (
            <span className="mt-0.5 shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-bold leading-4 text-primary-foreground"
              aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </span>
        {lastMessage ? (
          <span className="mt-2 flex gap-2">
            <IdentityAvatar kind={lastMessage.from.kind === "user" ? "human" : lastMessage.from.kind}
              label={lastMessage.from.label} initials={avatarInitials(lastMessage.from.label)} size="xs" shape="circle"
              className="mt-px" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-[13px] font-semibold text-foreground">{lastMessage.from.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelativeAge(lastMessage.sentAt) ?? ""}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-[13px] leading-[1.4] text-foreground/85">{lastMessage.bodyPreview}</span>
            </span>
          </span>
        ) : agents.length === 0 && (
          <span className="mt-1 block text-[12px] text-muted-foreground">
            {formatRelativeAge(conversation.activityAt) ?? ""}
          </span>
        )}
        <WorkingLine agents={agents} className="mt-2" />
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
/** Room between an empty thread's note and its composer. */
const EMPTY_THREAD_GAP = 12;

const threadAction = "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

/**
 * The open conversation, as a selected comment thread in Google Docs: raised
 * above the other cards and nudged toward the text, with what it is about,
 * then the conversation itself, sized to what it says.
 */
function OpenConversationCard({ conversation, quietAgents = false, canResolve, children, onResolve, onExpand, onClose, onFocus }: {
  conversation: MarginConversation;
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
  // with nothing said yet is its note and its composer.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let list: Element | null = null;
    let empty: Element | null = null;
    let composer: HTMLElement | null = null;
    const measure = () => {
      const header = headerRef.current?.offsetHeight ?? 0;
      const rows = list ? [...list.children].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) : 0;
      const note = empty && composer
        ? Math.max(0, ...[...empty.children].map((child) => child.getBoundingClientRect().bottom)) - empty.getBoundingClientRect().top
        : 0;
      const next = rows > 0 ? Math.ceil(header + rows)
        : note > 0 && composer ? Math.ceil(header + note + EMPTY_THREAD_GAP + composer.offsetHeight) : null;
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
      style={{ height: height ? `min(${height}px, ${OPEN_MAX_HEIGHT})` : OPEN_MAX_HEIGHT }}
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
  children: ReactNode;
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
            {last && <span className="text-muted-foreground"> · {last.from.label}: {last.bodyPreview}</span>}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * The page's margin (pages-live-document.md §4.4): each live conversation
 * beside what it is about, as comments are in Google Docs. `tops` are the
 * anchors' offsets from the top of the document, which the margin shares.
 * The open conversation expands in its card's place, level with its anchor,
 * and the other cards make room above and below it.
 */
export function PageMargin({ conversations, writers = [], tops, focusedId, openId = null, renderOpen, canResolve, onOpen,
  onResolve, onExpand, onClose, onFocus, onWriter, writerActions }: {
  conversations: MarginConversation[];
  /** The Agents at work on the page. Each stands beside its line, and its channel's card is not drawn again. */
  writers?: readonly MarginWriter[];
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
  /** An Agent pressed whose channel the page cannot open beside it. */
  onWriter?: (writer: MarginWriter) => void;
  /** What may be done to an Agent whose channel is open. */
  writerActions?: (person: PresentPerson) => ReactNode;
}) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const withWriters = new Set(writers.flatMap((writer) => writer.conversation ? [writer.conversation.conversationId] : []));
  const cards = conversations.filter((conversation) => conversation.live && !withWriters.has(conversation.conversationId));
  // A channel open beside the page opens under the first of its Agents at work, or in its card's place.
  const holder = openId ? writers.find((writer) => writer.conversation?.conversationId === openId) ?? null : null;
  const writerId = (writer: MarginWriter) => `writer:${writer.key}`;
  const items = [
    ...cards.map((card) => ({ id: card.conversationId, top: anchorTop(tops, card), estimate: ESTIMATED_CARD_HEIGHT })),
    ...writers.map((writer) => ({ id: writerId(writer), estimate: ESTIMATED_WRITER_HEIGHT,
      top: (tops.get(writer.anchor) ?? anchorTop(tops, { anchor: writer.anchor, blockId: writer.person.blockId })) - WRITER_RISE })),
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

  // Opened from elsewhere (a cursor label, a heading), the conversation scrolls into view where it sits.
  useEffect(() => {
    if (!openItem) return;
    const frame = window.requestAnimationFrame(() =>
      nodes.current.get(openItem)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    return () => window.cancelAnimationFrame(frame);
  }, [openItem]);

  // Only the open conversation moves the column. A hovered card only lights up:
  // moving it would slide another card under the pointer, which then moves in turn.
  const positions = layoutMargin(items.map((item) => ({ id: item.id, top: item.top,
    height: heights.get(item.id) ?? item.estimate })), openItem);
  const bottom = Math.max(0, ...items.map((item) => (positions.get(item.id) ?? 0) + (heights.get(item.id) ?? item.estimate)));
  const openCard = (conversation: MarginConversation, quietAgents: boolean) => renderOpen && (
    <OpenConversationCard conversation={conversation} quietAgents={quietAgents} canResolve={canResolve}
      onResolve={() => conversation.linkId && onResolve(conversation.linkId)}
      {...(onExpand ? { onExpand: () => onExpand(conversation.conversationId) } : {})}
      {...(onClose ? { onClose } : {})}
      onFocus={(focused) => onFocus(focused ? conversation.conversationId : null)}>
      {renderOpen()}
    </OpenConversationCard>
  );
  const place = (id: string, child: ReactNode) => (
    <div key={id} className="absolute inset-x-0 transition-[top] duration-150" style={{ top: positions.get(id) ?? 0 }}
      ref={(node) => { if (node) nodes.current.set(id, node); else nodes.current.delete(id); }}>
      {child}
    </div>
  );

  return (
    <div className="relative" style={{ minHeight: bottom }} data-testid="page-margin" aria-label="Conversations on this page">
      {cards.map((card) => place(card.conversationId, card.conversationId === openId && renderOpen ? openCard(card, false) : (
        <ConversationCard conversation={card} focused={card.conversationId === focusedId} canResolve={canResolve}
          onOpen={() => onOpen(card.conversationId)}
          onResolve={() => card.linkId && onResolve(card.linkId)}
          onFocus={(focused) => onFocus(focused ? card.conversationId : null)} />
      )))}
      {writers.map((writer) => {
        const conversation = writer.conversation;
        const open = Boolean(conversation && writer === holder && renderOpen);
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
  );
}

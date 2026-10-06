"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Maximize2, Sparkles, X } from "lucide-react";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import { formatRelativeAge } from "@/components/dashboard/time-display";
import { avatarInitials } from "@/components/dashboard/completion-option-button";
import { cn } from "@/lib/utils";
import { anchorTop, layoutMargin, type MarginConversation } from "./page-margin-model";

/** A card's height before it is measured. */
const ESTIMATED_CARD_HEIGHT = 76;

/** How an Agent's state reads on a card: working on a turn, or there and idle. */
export function agentState(status: MarginConversation["agents"][number]["status"]): string {
  return status === "busy" ? "Working" : "Idle";
}

/** What a card is about: a discussion's passage, or the conversation's name. */
function CardContext({ conversation }: { conversation: MarginConversation }) {
  return conversation.quote ? (
    <span className="page-margin-quote block truncate pl-2 text-[12px] leading-4 text-muted-foreground">
      {conversation.quote}
    </span>
  ) : (
    <span className="block truncate text-[13px] font-semibold leading-5 text-foreground">
      {conversation.name ?? "Conversation"}
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
      <Sparkles className={cn("size-3 shrink-0", working.length > 0 && "animate-pulse text-primary")} />
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

const threadAction = "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

/**
 * The open conversation, as a selected comment thread in Google Docs: raised
 * above the other cards and nudged toward the text, with what it is about,
 * then the conversation itself, sized to what it says.
 */
function OpenConversationCard({ conversation, canResolve, children, onResolve, onExpand, onClose, onFocus }: {
  conversation: MarginConversation;
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
  // header, messages and footer) and sets its own height from them.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let list: Element | null = null;
    const measure = () => {
      const rows = list ? [...list.children].reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) : 0;
      const next = rows > 0 ? Math.ceil((headerRef.current?.offsetHeight ?? 0) + rows) : null;
      setHeight((current) => current === next ? current : next);
    };
    const sizes = new ResizeObserver(measure);
    const attach = () => {
      const found = body.querySelector(".app-message-timeline > div > div");
      if (found !== list) {
        list = found;
        sizes.disconnect();
      }
      if (list) for (const row of list.children) sizes.observe(row);
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
          <CardContext conversation={conversation} />
          {conversation.quote && conversation.name && (
            <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{conversation.name}</span>
          )}
          <WorkingLine agents={conversation.agents} className="mt-1" />
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
 * The page's margin (pages-live-document.md §4.4): each live conversation
 * beside what it is about, as comments are in Google Docs. `tops` are the
 * anchors' offsets from the top of the document, which the margin shares.
 * The open conversation expands in its card's place, level with its anchor,
 * and the other cards make room above and below it.
 */
export function PageMargin({ conversations, tops, focusedId, openId = null, renderOpen, canResolve, onOpen, onResolve,
  onExpand, onClose, onFocus }: {
  conversations: MarginConversation[];
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
}) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const cards = conversations.filter((conversation) => conversation.live);
  const cardKey = cards.map((card) => card.conversationId).join("\u0000");

  // Cards grow with their content; each measured height moves the ones after it.
  useLayoutEffect(() => {
    const measure = () => setHeights((current) => {
      const next = new Map<string, number>();
      for (const [id, node] of nodes.current) next.set(id, node.offsetHeight);
      const same = next.size === current.size && [...next].every(([id, height]) => current.get(id) === height);
      return same ? current : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of nodes.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [cardKey]);

  // Opened from elsewhere (a cursor label, a heading), the conversation scrolls into view where it sits.
  useEffect(() => {
    if (!openId) return;
    const frame = window.requestAnimationFrame(() =>
      nodes.current.get(openId)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    return () => window.cancelAnimationFrame(frame);
  }, [openId]);

  // Only the open conversation moves the column. A hovered card only lights up:
  // moving it would slide another card under the pointer, which then moves in turn.
  const positions = layoutMargin(cards.map((card) => ({ id: card.conversationId,
    top: anchorTop(tops, card), height: heights.get(card.conversationId) ?? ESTIMATED_CARD_HEIGHT })),
  openId);
  const bottom = Math.max(0, ...cards.map((card) =>
    (positions.get(card.conversationId) ?? 0) + (heights.get(card.conversationId) ?? ESTIMATED_CARD_HEIGHT)));

  return (
    <div className="relative" style={{ minHeight: bottom }} data-testid="page-margin" aria-label="Conversations on this page">
      {cards.map((card) => (
        <div key={card.conversationId} className="absolute inset-x-0 transition-[top] duration-150"
          style={{ top: positions.get(card.conversationId) ?? 0 }}
          ref={(node) => { if (node) nodes.current.set(card.conversationId, node); else nodes.current.delete(card.conversationId); }}>
          {card.conversationId === openId && renderOpen ? (
            <OpenConversationCard conversation={card} canResolve={canResolve}
              onResolve={() => card.linkId && onResolve(card.linkId)}
              {...(onExpand ? { onExpand: () => onExpand(card.conversationId) } : {})}
              {...(onClose ? { onClose } : {})}
              onFocus={(focused) => onFocus(focused ? card.conversationId : null)}>
              {renderOpen()}
            </OpenConversationCard>
          ) : (
            <ConversationCard conversation={card} focused={card.conversationId === focusedId} canResolve={canResolve}
              onOpen={() => onOpen(card.conversationId)}
              onResolve={() => card.linkId && onResolve(card.linkId)}
              onFocus={(focused) => onFocus(focused ? card.conversationId : null)} />
          )}
        </div>
      ))}
    </div>
  );
}

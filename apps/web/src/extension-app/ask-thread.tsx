/**
 * Inline thread popover, right-edge dock tab, and quote-to-side-panel pill for
 * the Chrome extension's on-page surface (apps/chrome-extension/app/ask.html).
 *
 * Design principles (Daniel 2026-11-24):
 * - Zero borders and zero dividing lines: pure paper surface contrast.
 * - Sending from the selection box stays in place as a live inline thread card
 *   rather than jolting focus to Chrome's right side panel.
 * - Minimizing (or closing the side panel when a thread already exists on the
 *   page) docks a quiet warm-paper tab flush to the right viewport edge so the
 *   user can always pull the side panel open onto the exact same conversation.
 * - When the side panel is already open, text selection shows only a lightweight
 *   "Quote to side panel" pill so there are never two competing input boxes.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, CornerDownRight, PanelRightOpen, SendHorizontal, X } from "lucide-react";
import {
  CLIENT_COMPATIBILITY_POLICY,
  HUMAN_CLIENT_BROWSER_READ,
  HUMAN_HEARTBEAT_PING,
  deriveHumanConnectionUrl,
  isAgentInstruction,
  withClientCompatibilityQuery,
  type AuthUser,
  type ChannelMessage,
  type ClientCompatibilityIdentity,
  type HumanServerMessage,
  type SerializedSpace,
} from "@xmatrix/protocol";
import canonicalVersion from "../../../../version.json" with { type: "json" };
import { Composer } from "@/components/dashboard/workspace-composer-dialogs";
import { RichMessageContent } from "@/components/dashboard/workspace-shell-rich-message";
import type { ComposerSendSnapshot } from "@/components/dashboard/workspace-shell-message-model";
import { EXTENSION_CLIENT_PLATFORM } from "@/lib/extension-embed";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { getXMatrixHubUrl } from "@/lib/xmatrix";

export type InlineThreadTarget = {
  spaceId: string;
  channelId: string;
  title: string;
};

export type OptimisticInlineMessage = {
  clientMessageId: string;
  body: string;
  sentAt: string;
  senderName: string;
};

type DisplayMessage = {
  id: string;
  clientMessageId?: string;
  senderKind: "user" | "agent" | "system";
  senderName: string;
  body: string;
  sentAt: string;
  pending?: boolean;
};

const RUNTIME_OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function inlineHumanSocketUrl(userId: string): string {
  const identity: ClientCompatibilityIdentity = {
    component: "app",
    version: canonicalVersion.version,
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    platform: EXTENSION_CLIENT_PLATFORM,
  };
  const url = new URL(withClientCompatibilityQuery(deriveHumanConnectionUrl(getXMatrixHubUrl()), identity));
  if (RUNTIME_OWNER_ID.test(userId)) url.searchParams.set("owner", userId);
  return url.toString();
}

function isHiddenSystemMessage(message: ChannelMessage): boolean {
  if (message.deletedAt || message.recalledAt) return true;
  if (isAgentInstruction(message.metadata)) return true;
  if (message.from.kind === "system" && !message.body.trim()) return true;
  return false;
}

function toDisplayMessage(message: ChannelMessage): DisplayMessage {
  return {
    id: message.messageId,
    senderKind: message.from.kind === "agent" ? "agent" : message.from.kind === "system" ? "system" : "user",
    senderName: message.from.label || (message.from.kind === "agent" ? "Agent" : "You"),
    body: message.body,
    sentAt: message.sentAt,
  };
}

function mergeChannelMessages(current: ChannelMessage[], incoming: ChannelMessage[]): ChannelMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, ChannelMessage>();
  for (const item of current) byId.set(item.messageId, item);
  for (const item of incoming) byId.set(item.messageId, item);
  return [...byId.values()].sort((a, b) => {
    if (typeof a.sequence === "number" && typeof b.sequence === "number" && a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return a.sentAt.localeCompare(b.sentAt);
  });
}

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function useInlineThreadStream({
  active,
  channelId,
  token,
  userId,
  onBrowserRead,
  onActivity,
}: {
  active: boolean;
  channelId: string | null;
  token: string | null;
  userId: string | null;
  onBrowserRead: (request: { requestId: string; target: string }) => void;
  onActivity?: (kind: "agent-reply" | "agent-busy" | "agent-idle") => void;
}) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [confirmedClientIds, setConfirmedClientIds] = useState<ReadonlySet<string>>(() => new Set());
  const onBrowserReadRef = useRef(onBrowserRead);
  const onActivityRef = useRef(onActivity);
  onBrowserReadRef.current = onBrowserRead;
  onActivityRef.current = onActivity;

  // Reset state when switching to a different channel.
  useEffect(() => {
    setMessages([]);
    setBusyAgent(null);
    setConfirmedClientIds(new Set());
  }, [channelId]);

  // Immediate HTTP history load so revisiting an existing page conversation renders immediately.
  useEffect(() => {
    if (!active || !channelId || !token) return;
    let live = true;
    void xmatrixApiRequest<{ messages?: ChannelMessage[] }>({
      url: `/api/xmatrix/channels/${encodeURIComponent(channelId)}/history?limit=50`,
      token,
    })
      .then((res) => {
        if (!live || !Array.isArray(res?.messages)) return;
        setMessages((prev) => mergeChannelMessages(prev, res.messages ?? []));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [active, channelId, token]);

  // Live Human WebSocket subscription (also answers `browser_read_requested` so `xmatrix browse` works).
  useEffect(() => {
    if (!active || !channelId || !token || !userId) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const cleanupSocket = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (ws) {
        const socket = ws;
        ws = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try { socket.close(); } catch { /* ignore */ }
      }
    };

    const connect = () => {
      if (disposed) return;
      try {
        ws = new WebSocket(inlineHumanSocketUrl(userId));
      } catch {
        return;
      }
      const socket = ws;
      socket.onopen = () => {
        attempt = 0;
        socket.send(JSON.stringify({
          type: "human_connect",
          token,
          requestId: "ask-inline",
          device: {
            client: "app",
            platform: EXTENSION_CLIENT_PLATFORM,
            version: canonicalVersion.version,
            protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
            capabilities: [HUMAN_CLIENT_BROWSER_READ],
          },
        }));
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(HUMAN_HEARTBEAT_PING);
        }, 25_000);
      };
      socket.onmessage = (event) => {
        if (disposed || typeof event.data !== "string") return;
        let frame: HumanServerMessage;
        try {
          frame = JSON.parse(event.data) as HumanServerMessage;
        } catch {
          return;
        }
        if (frame.type === "human_connected" || frame.type === "user_subscribed") {
          socket.send(JSON.stringify({
            type: "user_focus_channel",
            requestId: `ask-focus:${channelId}`,
            channelId,
            historyLimit: 50,
          }));
        } else if (frame.type === "channel_history" && frame.channelId === channelId) {
          setMessages((prev) => mergeChannelMessages(prev, frame.messages ?? []));
        } else if (frame.type === "channel_message_received" && frame.message?.channelId === channelId) {
          const clientId = frame.clientMessageId;
          if (clientId) {
            setConfirmedClientIds((prev) => {
              if (prev.has(clientId)) return prev;
              const next = new Set(prev);
              next.add(clientId);
              return next;
            });
          }
          setMessages((prev) => mergeChannelMessages(prev, [frame.message]));
          if (frame.message.from.kind === "agent") {
            setBusyAgent(null);
            onActivityRef.current?.("agent-reply");
          }
        } else if (frame.type === "channel_message_updated" && frame.channelId === channelId && frame.message) {
          setMessages((prev) => mergeChannelMessages(prev, [frame.message]));
        } else if (frame.type === "agent_lifecycle" && frame.channelId === channelId) {
          const activeStates = new Set(["starting", "running", "thinking", "working", "responding", "executing"]);
          if (activeStates.has(String(frame.status))) {
            setBusyAgent(frame.agentName || "Agent");
            onActivityRef.current?.("agent-busy");
          } else {
            setBusyAgent((current) => (current === frame.agentName ? null : current));
            onActivityRef.current?.("agent-idle");
          }
        } else if (frame.type === "browser_read_requested") {
          onBrowserReadRef.current({ requestId: frame.requestId, target: frame.target });
        }
      };
      socket.onclose = () => {
        cleanupSocket();
        if (disposed) return;
        const delay = Math.min(8_000, 1_500 * Math.max(1, ++attempt));
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => {
        // onclose handles reconnect.
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cleanupSocket();
    };
  }, [active, channelId, token, userId]);

  return { messages, busyAgent, confirmedClientIds };
}

export function InlineThreadCard({
  thread,
  messages,
  optimisticMessages,
  confirmedClientIds,
  busyAgent,
  awaitingFirstReply,
  space,
  token,
  error,
  draftRevision,
  onSendFollowUp,
  onDockToSidePanel,
  onMinimize,
}: {
  thread: InlineThreadTarget | null;
  messages: ChannelMessage[];
  optimisticMessages: OptimisticInlineMessage[];
  confirmedClientIds: ReadonlySet<string>;
  busyAgent: string | null;
  awaitingFirstReply: boolean;
  space: SerializedSpace | null;
  token: string;
  user: AuthUser;
  error: string | null;
  draftRevision: number;
  onSendFollowUp: (snapshot: ComposerSendSnapshot) => Promise<void>;
  onDockToSidePanel: () => void;
  onMinimize: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  const visibleMessages: DisplayMessage[] = [];
  const committedBodies = new Set<string>();
  for (const item of messages) {
    if (isHiddenSystemMessage(item)) continue;
    visibleMessages.push(toDisplayMessage(item));
    committedBodies.add(item.body.trim());
  }
  for (const pending of optimisticMessages) {
    if (confirmedClientIds.has(pending.clientMessageId)) continue;
    // If history already arrived with the same human message before the live echo, skip the duplicate.
    if (committedBodies.has(pending.body.trim())) continue;
    visibleMessages.push({
      id: `pending:${pending.clientMessageId}`,
      clientMessageId: pending.clientMessageId,
      senderKind: "user",
      senderName: pending.senderName,
      body: pending.body,
      sentAt: pending.sentAt,
      pending: true,
    });
  }

  const hasAgentReply = visibleMessages.some((item) => item.senderKind === "agent");
  const showThinking = Boolean(busyAgent) || (awaitingFirstReply && !hasAgentReply);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [visibleMessages.length, showThinking]);

  return (
    <div
      data-ask-box="true"
      className="ask-thread-card flex w-full flex-col overflow-hidden rounded-[20px] bg-white text-foreground shadow-[0_10px_24px_rgba(32,24,16,0.13),0_1px_5px_rgba(32,24,16,0.06)]"
    >
      {/* Quiet borderless header: title + live state + dock to side panel + minimize to edge */}
      <div className="flex items-center gap-2 bg-white px-4 pt-3 pb-2">
        {/* oxlint-disable-next-line next/no-img-element */}
        <img src="../assets/mark.png" alt="" className="size-4 shrink-0 rounded-[4px]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em] text-foreground/90">
          {thread?.title || "xMatrix"}
        </span>
        {showThinking ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[oklch(0.962_0.014_80)] px-2 py-0.5 text-[11px] font-medium text-foreground/70">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            {busyAgent ? `${busyAgent}…` : "Thinking…"}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onDockToSidePanel}
          title="Open in right side panel"
          aria-label="Open in right side panel"
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/55 transition-colors hover:bg-[oklch(0.955_0.008_80)] hover:text-foreground"
        >
          <PanelRightOpen className="size-4" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={onMinimize}
          title="Minimize to right edge"
          aria-label="Minimize to right edge"
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground/55 transition-colors hover:bg-[oklch(0.955_0.008_80)] hover:text-foreground"
        >
          <X className="size-4" strokeWidth={1.8} />
        </button>
      </div>

      {/* Live conversation stream — zero borders, editorial paper readability */}
      <div
        ref={scrollerRef}
        className="max-h-[21rem] min-h-[7.5rem] space-y-3 overflow-y-auto bg-white px-4 pt-1 pb-3"
      >
        {visibleMessages.map((item) => (
          <div
            key={item.id}
            className={
              item.senderKind === "user"
                ? "rounded-[14px] bg-[oklch(0.968_0.009_80)] px-3 py-2 text-[13.5px] leading-[1.5]"
                : item.senderKind === "system"
                  ? "px-1 text-[12px] leading-[1.45] text-muted-foreground"
                  : "px-0.5 text-[13.5px] leading-[1.55]"
            }
          >
            {item.senderKind !== "system" ? (
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[11.5px] font-semibold tracking-[-0.01em] text-foreground/75">
                  {item.senderName}
                </span>
                <span className="text-[10.5px] text-muted-foreground/75">
                  {item.pending ? "Sending…" : formatShortTime(item.sentAt)}
                </span>
              </div>
            ) : null}
            <RichMessageContent body={item.body} />
          </div>
        ))}
        {showThinking ? (
          <div className="flex items-center gap-2 px-1 py-1 text-[12.5px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            <span>{busyAgent ? `${busyAgent} is replying…` : "Waiting for Agent…"}</span>
          </div>
        ) : null}
      </div>

      {/* Borderless warm-paper follow-up composer flush to bottom */}
      <div className="ask-thread-composer">
        <Composer
          channel={null}
          draftIdentity={`extension-ask-thread:${thread?.channelId ?? "pending"}`}
          instanceTargetScope="none"
          startsConversation={false}
          attachmentsEnabled={false}
          panelPlacement="above"
          space={space}
          token={token}
          workspaces={[]}
          localContext={null}
          isJoined
          draft=""
          draftSeedRevision={draftRevision}
          selectedWorkspaceId={null}
          replyTarget={null}
          attachments={[]}
          mentionInsertRequest={null}
          autoFocusRequest={0}
          error={error}
          ariaLabel="Follow up in this conversation"
          sendTitle="Send"
          sendIcon={<SendHorizontal className="size-[16px]" strokeWidth={2.1} />}
          onDraftChange={() => undefined}
          onWorkspaceSelect={() => undefined}
          onCancelReply={() => undefined}
          onAttachmentsChange={() => undefined}
          onOpenAppsForSpace={() => undefined}
          onEscape={onMinimize}
          onSend={onSendFollowUp}
        />
      </div>
    </div>
  );
}

/**
 * Flush right-edge dock tab: appears ONLY when this page already has a thread
 * and Chrome's side panel is closed. Signals clearly that the right side panel
 * can be opened straight back onto the conversation.
 */
export function EdgeDockTab({
  liveIndicator,
  onOpenSidePanel,
}: {
  liveIndicator: "idle" | "busy" | "unread";
  onOpenSidePanel: () => void;
}) {
  return (
    <button
      type="button"
      data-ask-box="true"
      onClick={onOpenSidePanel}
      title="Open conversation in right side panel"
      aria-label="Open conversation in right side panel"
      className="ask-edge-dock group relative flex h-11 cursor-pointer items-center gap-1.5 rounded-l-[14px] rounded-r-none bg-[oklch(0.968_0.011_80)] pr-2.5 pl-2 text-foreground shadow-[-3px_4px_14px_rgba(32,24,16,0.12),-1px_1px_4px_rgba(32,24,16,0.05)] transition-all duration-150 hover:bg-[oklch(0.948_0.014_79)] hover:pr-3"
    >
      <ChevronLeft
        className="size-3.5 text-foreground/45 transition-transform duration-150 group-hover:-translate-x-0.5 group-hover:text-foreground/80"
        strokeWidth={2.2}
      />
      <span className="relative flex size-6 items-center justify-center">
        {/* oxlint-disable-next-line next/no-img-element */}
        <img src="../assets/mark.png" alt="" className="size-5 rounded-[5px]" />
        {liveIndicator !== "idle" ? (
          <span
            className={
              liveIndicator === "busy"
                ? "absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse"
                : "absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary"
            }
          />
        ) : null}
      </span>
    </button>
  );
}

/**
 * Lightweight pill shown when the side panel is already open for this tab,
 * avoiding a second competing input box on the page.
 */
export function QuoteToPanelPill({
  onQuote,
}: {
  onQuote: () => void;
}) {
  return (
    <button
      type="button"
      data-ask-box="true"
      onClick={onQuote}
      className="ask-quote-pill inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-white px-3.5 text-[13px] font-medium tracking-[-0.01em] text-foreground shadow-[0_8px_24px_rgba(32,24,16,0.15),0_1px_4px_rgba(32,24,16,0.07)] transition-colors hover:bg-[oklch(0.965_0.010_80)]"
    >
      <CornerDownRight className="size-3.5 text-foreground/65" strokeWidth={2.1} />
      <span>Quote to side panel</span>
    </button>
  );
}

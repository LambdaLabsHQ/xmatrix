/**
 * Inline thread popover, right-edge dock tab, and quote-to-side-panel pill for
 * the Chrome extension's on-page surface (apps/chrome-extension/app/ask.html).
 *
 * Architecture:
 * - One real App (`./index.html?inline=1`) from Frame 0: zero hand-written
 *   optimistic message replica, zero dummy composer, zero skeleton screen, zero
 *   60ms DOM polling, zero `execCommand` draft migration, and zero hand-written
 *   WebSocket.
 * - First messages start directly through the real App's own 0ms deterministic
 *   `beginConversation` + `sendNewConversationMessage` path (`start-conversation`),
 *   so the sent message appears on Frame 0 and failures stay retryable in-place.
 * - Pre-warmed strictly on demand (drag-start, ask-focus, or thread-open) and
 *   released automatically when the side panel opens, the tab goes to background,
 *   or after idle.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, CornerDownRight, Loader2, PanelRightOpen, X } from "lucide-react";
import type { AuthUser, SerializedChannel } from "@xmatrix/protocol";
import type { EmbedPendingMessage, EmbedStartConversation } from "@/lib/extension-embed";

const EMBED_PROTOCOL = "xmatrix-embed/1";
const CHANNEL_PATH_RE = /^\/app\/([A-Za-z0-9_-]{1,128})\/channels\/([A-Za-z0-9_-]{1,128})$/u;

export type InlineThreadTarget = {
  spaceId: string;
  channelId: string;
  title: string;
  snapshot?: SerializedChannel | null;
};

/**
 * Inline conversation popover backed directly by the packaged xMatrix App
 * (`./index.html?inline=1`).
 */
export function InlineThreadCard({
  visible = true,
  expanding = false,
  thread,
  placement = "below",
  morphStartHeight = 52,
  pendingStart = null,
  pendingMessage,
  quotePassage,
  passage,
  token,
  user,
  tabId,
  error,
  askExtension,
  onDockToSidePanel,
  onMinimize,
  onThreadBound,
  onThreadCleared,
  onPendingSendsChange,
}: {
  visible?: boolean;
  expanding?: boolean;
  thread: InlineThreadTarget | null;
  placement?: "above" | "below";
  morphStartHeight?: number;
  pendingStart?: EmbedStartConversation | null;
  pendingMessage: EmbedPendingMessage | null;
  quotePassage?: { text: string; label: string; href: string; round: number } | null;
  passage: { text: string; label: string; href: string } | null;
  token: string;
  user: AuthUser;
  tabId: number | null;
  error: string | null;
  askExtension: <T>(type: string, args?: unknown) => Promise<T>;
  onDockToSidePanel: (options?: { messageId?: string }) => void;
  onMinimize: () => void;
  onThreadBound?: (thread: InlineThreadTarget) => void;
  onThreadCleared?: (unsentDraft?: string, error?: string) => void;
  onPendingSendsChange?: (count: number) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const appReadyRef = useRef(false);
  const openedPathRef = useRef<string | null>(null);
  const startedIdRef = useRef<string | null>(null);
  const lastSentPageRef = useRef<string | null>(null);
  const quotedRoundRef = useRef<number | null>(null);
  const [appReady, setAppReady] = useState(false);

  const latestRef = useRef({
    thread,
    pendingStart,
    pendingMessage,
    passage,
    token,
    user,
    tabId,
    askExtension,
    onDockToSidePanel,
    onMinimize,
    onThreadBound,
    onThreadCleared,
    onPendingSendsChange,
  });
  latestRef.current = {
    thread,
    pendingStart,
    pendingMessage,
    passage,
    token,
    user,
    tabId,
    askExtension,
    onDockToSidePanel,
    onMinimize,
    onThreadBound,
    onThreadCleared,
    onPendingSendsChange,
  };

  const channelPath = thread?.spaceId && thread?.channelId
    ? `/app/${encodeURIComponent(thread.spaceId)}/channels/${encodeURIComponent(thread.channelId)}`
    : null;

  // Mount `./index.html?inline=1` at the target channel when known, or cleanly at `/app`
  // (where inlinePopover renders a blank white canvas without restoring another tab's last channel).
  const [frameSrc] = useState<string>(() => {
    const params = new URLSearchParams({ inline: "1" });
    if (typeof tabId === "number" && Number.isInteger(tabId) && tabId > 0) params.set("tab", String(tabId));
    if (channelPath) params.set("at", channelPath);
    return `./index.html?${params.toString()}`;
  });

  // Speak `xmatrix-embed/1` with the embedded `./index.html` frame (same protocol as sidepanel.js).
  useEffect(() => {
    const appOrigin = window.location.origin;
    const postToApp = (message: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage({ protocol: EMBED_PROTOCOL, ...message }, appOrigin);
    };
    const pushInitialState = () => {
      const { thread: t, pendingStart: start, pendingMessage: pending, passage: p } = latestRef.current;
      const path = t?.spaceId && t?.channelId
        ? `/app/${encodeURIComponent(t.spaceId)}/channels/${encodeURIComponent(t.channelId)}`
        : null;
      if (p?.href) {
        lastSentPageRef.current = `${path ?? ""}\0${p.href}\0${p.label}`;
        postToApp({ type: "page", title: p.label, href: p.href, ...(path ? { path } : {}) });
      }
      if (start && startedIdRef.current !== start.id) {
        startedIdRef.current = start.id;
        postToApp({ type: "start-conversation", ...start });
        return;
      }
      if (path) {
        openedPathRef.current = path;
        postToApp({
          type: "open",
          path,
          ...(t?.snapshot ? { channel: t.snapshot } : {}),
          ...(pending ? { pending } : {}),
        });
      }
    };

    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== appOrigin || event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.protocol !== EMBED_PROTOCOL) return;
      const {
        token: currentToken,
        user: currentUser,
        tabId: currentTabId,
        askExtension: rpc,
        onDockToSidePanel: dockToPanel,
        onMinimize: minimize,
        onThreadBound: bindThread,
        onThreadCleared: clearThread,
        onPendingSendsChange: reportPendingSends,
      } = latestRef.current;

      if (data.type === "session-request" && typeof data.id === "string") {
        if (data.renew === true) {
          const renewed = await rpc<{ token: string; user?: AuthUser } | null>("session", { renew: true }).catch(() => null);
          postToApp(renewed
            ? { type: "session", id: data.id, token: renewed.token, ...(renewed.user ? { user: renewed.user } : {}) }
            : { type: "signed-out", id: data.id });
        } else {
          postToApp({ type: "session", id: data.id, token: currentToken, user: currentUser });
        }
      } else if (data.type === "ready") {
        appReadyRef.current = true;
        setAppReady(true);
        if (typeof currentTabId === "number" && Number.isInteger(currentTabId) && currentTabId > 0) {
          postToApp({ type: "host-tab", tabId: currentTabId });
        }
        pushInitialState();
      } else if (data.type === "minimize") {
        minimize();
      } else if (data.type === "dock-to-panel") {
        dockToPanel(typeof data.messageId === "string" && data.messageId ? { messageId: data.messageId } : undefined);
      } else if (data.type === "pending-sends" && typeof data.count === "number") {
        reportPendingSends?.(data.count);
      } else if (data.type === "outbox-register" && data.entry && typeof data.entry === "object") {
        void rpc("outboxRegister", { ...(data.entry as Record<string, unknown>), source: "inline" }).catch(() => undefined);
      } else if (data.type === "outbox-ack" && typeof data.clientMessageId === "string") {
        void rpc("outboxAck", { clientMessageId: data.clientMessageId }).catch(() => undefined);
      } else if (data.type === "page-thread" && typeof data.path === "string") {
        const match = CHANNEL_PATH_RE.exec(data.path);
        if (match) {
          openedPathRef.current = data.path;
          const title = typeof data.title === "string" ? data.title : "";
          const href = typeof data.href === "string" ? data.href : "";
          bindThread?.({ spaceId: match[1], channelId: match[2], title });
          void rpc("askRememberThread", {
            path: data.path,
            title,
            href,
            recordRecent: data.recordRecent !== false,
          }).catch(() => undefined);
        }
      } else if (data.type === "clear-page-thread") {
        openedPathRef.current = null;
        void rpc("askClearThread").catch(() => undefined);
        clearThread?.(
          typeof data.draft === "string" ? data.draft : undefined,
          typeof data.error === "string" ? data.error : undefined,
        );
      } else if (data.type === "space" && data.space && typeof data.space === "object") {
        void rpc("rememberSpace", { space: data.space }).catch(() => undefined);
      } else if (data.type === "account" && data.user && typeof data.user === "object") {
        void rpc("rememberAccount", { user: data.user }).catch(() => undefined);
      } else if (data.type === "browser-read" && typeof data.requestId === "string") {
        void rpc("askBrowserRead", {
          requestId: data.requestId,
          target: String(data.target ?? "current"),
          ...(typeof data.channelId === "string" && data.channelId ? { channelId: data.channelId } : {}),
          ...(typeof data.agentName === "string" && data.agentName ? { agentName: data.agentName } : {}),
        }).catch(() => undefined);
      } else if (data.type === "show-page" && typeof data.href === "string") {
        void rpc("showPage", { href: data.href, preferredTabId: currentTabId }).catch(() => undefined);
      } else if (data.type === "open-tab" && typeof data.href === "string") {
        window.open(data.href, "_blank", "noopener,noreferrer");
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      appReadyRef.current = false;
      window.removeEventListener("message", onMessage);
    };
  }, []);

  // Always sync the active page URL/title to the embedded App whenever the user navigates
  // to another tweet/page inside the same tab, even while the card stays open (Item 2).
  useEffect(() => {
    if (!appReady || !passage?.href) return;
    const key = `${channelPath ?? ""}\0${passage.href}\0${passage.label}`;
    if (lastSentPageRef.current === key) return;
    lastSentPageRef.current = key;
    const appOrigin = window.location.origin;
    iframeRef.current?.contentWindow?.postMessage({
      protocol: EMBED_PROTOCOL,
      type: "page",
      title: passage.label,
      href: passage.href,
      ...(channelPath ? { path: channelPath } : {}),
    }, appOrigin);
  }, [appReady, channelPath, passage?.href, passage?.label]);

  // Hand off a 0ms optimistic first-message start as soon as the pre-warmed App is ready (Item 1).
  useEffect(() => {
    if (!appReady || !pendingStart || startedIdRef.current === pendingStart.id) return;
    startedIdRef.current = pendingStart.id;
    const appOrigin = window.location.origin;
    if (pendingStart.href) {
      lastSentPageRef.current = `\0${pendingStart.href}\0${pendingStart.label ?? ""}`;
      iframeRef.current?.contentWindow?.postMessage({
        protocol: EMBED_PROTOCOL,
        type: "page",
        title: pendingStart.label ?? "",
        href: pendingStart.href,
      }, appOrigin);
    }
    iframeRef.current?.contentWindow?.postMessage({
      protocol: EMBED_PROTOCOL,
      type: "start-conversation",
      ...pendingStart,
    }, appOrigin);
  }, [appReady, pendingStart]);

  // Push existing channel / pending message when switching to an already-created tab thread.
  useEffect(() => {
    if (!appReady || !channelPath) return;
    if (openedPathRef.current === channelPath && !pendingMessage) return;
    openedPathRef.current = channelPath;
    const appOrigin = window.location.origin;
    iframeRef.current?.contentWindow?.postMessage({
      protocol: EMBED_PROTOCOL,
      type: "open",
      path: channelPath,
      ...(thread?.snapshot ? { channel: thread.snapshot } : {}),
      ...(pendingMessage ? { pending: pendingMessage } : {}),
    }, appOrigin);
  }, [appReady, channelPath, thread?.snapshot, pendingMessage]);

  // Hand the newly selected passage to the live inline conversation as an implicit quote (#2004:
  // the selection on the page IS the quote, so the composer stays clean with no quote card and
  // prepends the quote + link automatically when the message is sent).
  useEffect(() => {
    if (!appReady) return;
    const appOrigin = window.location.origin;
    if (!visible || !quotePassage?.text?.trim()) {
      quotedRoundRef.current = null;
      iframeRef.current?.contentWindow?.postMessage({
        protocol: EMBED_PROTOCOL,
        type: "clear-passage",
      }, appOrigin);
      return;
    }
    if (quotedRoundRef.current === quotePassage.round) return;
    quotedRoundRef.current = quotePassage.round;
    iframeRef.current?.contentWindow?.postMessage({
      protocol: EMBED_PROTOCOL,
      type: "passage",
      text: quotePassage.text,
      label: quotePassage.label,
      href: quotePassage.href,
      target: "current",
      focus: false,
      implicit: true,
    }, appOrigin);
  }, [appReady, visible, quotePassage]);

  const morphStyle = {
    ["--ask-morph-start-h" as string]: `${morphStartHeight}px`,
    ["--ask-morph-end-h" as string]: "min(30.5rem, max(16rem, calc(100vh - 48px)))",
  } as const;

  const containerStyle = visible
    ? {
        ...morphStyle,
        height: "var(--ask-morph-end-h)",
        justifyContent: placement === "above" ? "flex-end" : "flex-start",
      }
    : {
        // Stay mounted off-screen at real desktop card dimensions while warm on the active tab.
        position: "fixed" as const,
        left: "-10000px",
        top: "-10000px",
        width: "30rem",
        height: "30.5rem",
        visibility: "hidden" as const,
        pointerEvents: "none" as const,
      };

  const cardTitle = thread?.title || passage?.label || "xMatrix";

  return (
    <div
      data-ask-box={visible ? "true" : undefined}
      aria-hidden={!visible || undefined}
      className="flex w-full flex-col"
      style={containerStyle}
    >
      <div
        className={!visible
          ? "ask-thread-card flex w-full flex-col overflow-hidden rounded-[20px] bg-white text-foreground"
          : expanding
            ? "ask-thread-card ask-thread-card-expanding flex w-full flex-col overflow-hidden rounded-[20px] bg-white text-foreground shadow-[0_10px_28px_rgba(32,24,16,0.14),0_1px_5px_rgba(32,24,16,0.06)]"
            : "ask-thread-card ask-thread-card-open flex w-full flex-col overflow-hidden rounded-[20px] bg-white text-foreground shadow-[0_10px_28px_rgba(32,24,16,0.14),0_1px_5px_rgba(32,24,16,0.06)]"}
        style={{ height: visible ? "var(--ask-morph-end-h)" : "100%" }}
      >
        <div className={expanding
          ? "ask-thread-header-enter flex h-10 shrink-0 items-center gap-2 bg-white px-4"
          : "flex h-10 shrink-0 items-center gap-2 bg-white px-4"}
        >
          {/* oxlint-disable-next-line next/no-img-element */}
          <img src="../assets/mark.png" alt="" className="size-4 shrink-0 rounded-[4px]" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-[-0.01em] text-foreground/90">
            {cardTitle}
          </span>
          <button
            type="button"
            onClick={() => onDockToSidePanel()}
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

        {error ? (
          <p role="alert" className="shrink-0 px-4 pb-2 text-xs font-medium text-destructive">{error}</p>
        ) : null}

        <div className="relative min-h-0 flex-1 w-full bg-white">
          <iframe
            ref={iframeRef}
            src={frameSrc}
            title="xMatrix conversation"
            allow="clipboard-write"
            className="size-full border-0 bg-white"
          />
          {visible && !appReady ? (
            <div
              aria-label="Loading conversation"
              className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white"
            >
              <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Flush right-edge dock tab: appears ONLY when this page already has a thread
 * and Chrome's side panel is closed. Zero embedded App or WebSocket overhead while docked idle.
 */
export function EdgeDockTab({
  onOpenSidePanel,
}: {
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

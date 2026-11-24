/**
 * The extension's on-page surface (apps/chrome-extension src/selection.js frames
 * this page beside a selection or docked flush to the right viewport edge).
 *
 * Four coherent states (Daniel 2026-11-24):
 * 1. `ask`: the App's floating glass composer capsule under selected text.
 * 2. `thread`: pressing Enter expands in place into a live inline conversation
 *    card (connected to `/ws/humans` with `browser_read_v1`) rather than
 *    jolting focus to Chrome's side panel.
 * 3. `dock`: minimizing the card (or closing the side panel on a page that
 *    already has a thread) docks a quiet warm-paper tab on the right edge;
 *    clicking it (or the card's ◫ button) slides Chrome's side panel open onto
 *    the exact same conversation.
 * 4. `quote`: when Chrome's side panel is already open for this tab, selecting
 *    text offers a compact "Quote to side panel" pill instead of a second
 *    competing input box.
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { WEB_PROXY_ROUTES, type AuthUser, type ChannelSnapshot, type SerializedSpace } from "@xmatrix/protocol";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { Composer } from "@/components/dashboard/workspace-composer-dialogs";
import { askMessage } from "./ask-message";
import {
  EdgeDockTab,
  InlineThreadCard,
  QuoteToPanelPill,
  useInlineThreadStream,
  type InlineThreadTarget,
  type OptimisticInlineMessage,
} from "./ask-thread";
import {
  channelReferences,
  MessageReferenceCatalogProvider,
  type ChannelReference,
  type MessageReferenceCatalog,
} from "@/components/dashboard/message-reference-catalog";
import type { ComposerSendSnapshot } from "@/components/dashboard/workspace-shell-message-model";
import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";
import { LiquidGlassLensDefs } from "@/components/ui/liquid-glass-lens";
import { GrantedAuthProvider } from "@/lib/auth-context";
import { markExtensionAskSurface } from "@/lib/extension-embed";
import { UserFacingProblem } from "@/lib/user-facing-error";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { installLocalApi } from "./local-api";

installLocalApi(API_ROUTES);

type SurfaceMode = "ask" | "thread" | "dock" | "quote";

/** What the service worker hands this page: the session, the passage it was opened on, the Space and any page thread. */
type AskContext = {
  token: string;
  user: AuthUser;
  spaceId: string | null;
  passage: { text: string; label: string; href: string } | null;
  thread?: InlineThreadTarget | null;
  panelOpen?: boolean;
  /** The tab the box is on: its panel is the one that opens. */
  tabId: number | null;
  /** The selection it was read for: a new one seeds the composer's draft afresh. */
  round?: number;
};

type AskSendResult = {
  spaceName: string;
  spaceId: string;
  channelId: string;
  title: string;
  clientMessageId: string;
};

type Extension = {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string; code?: string } | undefined> };
  sidePanel?: { open: (options: { tabId: number }) => Promise<void> };
};
const extension = (globalThis as unknown as { chrome: Extension }).chrome;

/**
 * Asks the extension's service worker. Its refusals are sentences for the person ("Sign in to xMatrix in the side
 * panel first.", the Hub's own reason a conversation could not start): the box shows them as they are, not as an
 * unexplained "Something went wrong" (Daniel 2026-11-24: "Couldn't prepare the message" said nothing of why).
 */
async function ask<T>(type: string, args?: unknown): Promise<T> {
  const answer = await extension.runtime.sendMessage({ type, args }).catch(() => undefined);
  if (!answer?.ok) {
    throw Object.assign(new UserFacingProblem(answer?.error || "xMatrix could not be reached. Try again.", true),
      { code: answer?.code });
  }
  return answer.value as T;
}

/** The framing page places and hides the frame; it learns nothing else. */
function tellFrame(
  message:
    | { type: "ready" }
    | {
        type: "size";
        width: number;
        height: number;
        topInset: number;
        bottomInset: number;
        leftInset: number;
        rightInset: number;
      }
    | { type: "mode"; mode: "thread" | "dock" }
    | { type: "docked" }
    | { type: "close" },
) {
  window.parent.postMessage({ xmatrixAsk: true, ...message }, "*");
}

function Surface() {
  // Each selection is a new question: the composer starts over with its passage.
  const [round, setRound] = useState(0);
  const [mode, setMode] = useState<SurfaceMode>("ask");
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);
  const [context, setContext] = useState<AskContext | null>(null);
  const [activeThread, setActiveThread] = useState<InlineThreadTarget | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticInlineMessage[]>([]);
  const [awaitingFirstReply, setAwaitingFirstReply] = useState(false);
  const [dockIndicator, setDockIndicator] = useState<"idle" | "busy" | "unread">("idle");
  const [followUpRevision, setFollowUpRevision] = useState(0);
  const [space, setSpace] = useState<SerializedSpace | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const toldSize = useRef("");
  const measureNow = useRef<() => void>(() => undefined);
  const modeRef = useRef<SurfaceMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as {
        xmatrixAsk?: unknown;
        mode?: unknown;
        placement?: unknown;
        maxPanelHeight?: unknown;
      } | null;
      // The page handed the extension a new passage (or updated viewport room): adapt panel direction and height.
      if (data?.xmatrixAsk === "prepared" || data?.xmatrixAsk === "layout") {
        if (data.placement === "above" || data.placement === "below") setPlacement(data.placement);
        if (typeof data.maxPanelHeight === "number" && Number.isFinite(data.maxPanelHeight) && data.maxPanelHeight > 0) {
          setMaxPanelHeight(data.maxPanelHeight);
        }
        if (data.xmatrixAsk === "prepared") {
          setMode(data.mode === "quote" ? "quote" : "ask");
          setRound((current) => current + 1);
        }
      } else if (data?.xmatrixAsk === "dock") {
        setMode("dock");
        setRound((current) => current + 1);
      }
    };
    window.addEventListener("message", onMessage);
    // The page made this box before the person finished selecting; it hands the passage over once this says ready.
    tellFrame({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (round === 0) return;
    let live = true;
    sending.current = false;
    setProblem(null);
    const optionalPassage = modeRef.current === "dock";
    ask<AskContext>("askContext", { optionalPassage }).then((next) => {
      if (!live) return;
      markExtensionAskSurface(next.token);
      setContext({ ...next, round });
      if (next.thread) {
        setActiveThread((current) => current?.channelId === next.thread?.channelId ? current : next.thread ?? null);
      }
      // The stored token may be near its end: a renewed one replaces it, without holding the box back.
      void ask<{ token: string } | null>("session").then((session) => {
        if (!live || !session?.token || session.token === next.token) return;
        markExtensionAskSurface(session.token);
        setContext((current) => (current ? { ...current, token: session.token } : current));
      }).catch(() => undefined);
    }).catch((error: unknown) => {
      if (!live) return;
      if (modeRef.current === "dock") return;
      // Signed out is the person's to fix, so it says so; otherwise the box has no passage to ask about, and stays away.
      if ((error as { code?: unknown }).code === "signed_out") setProblem((error as Error).message);
      else tellFrame({ type: "close" });
    });
    return () => { live = false; };
  }, [round]);

  // The Space it asks in: what the composer completes `@` from, and names while empty.
  const token = context?.token;
  const spaceId = activeThread?.spaceId ?? context?.spaceId;
  useEffect(() => {
    if (!token || !spaceId) return;
    let live = true;
    void xmatrixApiRequest<{ spaces?: SerializedSpace[] }>({ url: "/api/xmatrix/spaces", token })
      .then(({ spaces = [] }) => {
        if (live) setSpace(spaces.find((item) => item.id === spaceId) ?? null);
      })
      .catch(() => undefined);
    // The Space's channels: what `#` completes, as it does in the App (message-reference-catalog.tsx).
    void xmatrixApiRequest<{ channels?: ChannelSnapshot[] }>({ url: WEB_PROXY_ROUTES.channels, token })
      .then(({ channels = [] }) => {
        if (live) setChannels(channelReferences([], channels.filter((channel) => channel.spaceId === spaceId)));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [token, spaceId]);
  const [channels, setChannels] = useState<readonly ChannelReference[]>([]);
  const referenceCatalog = useMemo<MessageReferenceCatalog | null>(() => channels.length
    ? { channels, channelActivityMs: () => 0, onOpenChannel: () => undefined } : null, [channels]);

  const handleBrowserRead = useCallback((request: { requestId: string; target: string }) => {
    void ask("askBrowserRead", request).catch(() => undefined);
  }, []);

  const handleStreamActivity = useCallback((kind: "agent-reply" | "agent-busy" | "agent-idle") => {
    if (kind === "agent-busy") {
      setDockIndicator("busy");
    } else if (kind === "agent-reply") {
      setAwaitingFirstReply(false);
      setDockIndicator(modeRef.current === "dock" ? "unread" : "idle");
    } else {
      setDockIndicator((current) => (current === "busy" ? "idle" : current));
    }
  }, []);

  // Keep the live stream connected while in inline thread OR minimized to the right-edge dock,
  // so replies continue arriving and `xmatrix browse` keeps working without the side panel.
  const streamActive = (mode === "thread" || mode === "dock") && Boolean(activeThread?.channelId && context?.token && context?.user?.id);
  const { messages, busyAgent, confirmedClientIds } = useInlineThreadStream({
    active: streamActive,
    channelId: activeThread?.channelId ?? null,
    token: context?.token ?? null,
    userId: context?.user?.id ?? null,
    onBrowserRead: handleBrowserRead,
    onActivity: handleStreamActivity,
  });

  // The frame is as big as its own box (the surface stays in normal flow inside it, so scrolled
  // completion rows or thread messages inside overflow-y:auto containers never distort reported height).
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    // Measured once per burst of changes, and told only when the size changed. Not in an animation frame:
    // Chrome pauses those in a hidden frame, and the page shows this one only once it hears its size.
    let scheduled = false;
    let live = true;
    const measure = () => {
      scheduled = false;
      if (!live) return;
      const rect = element.getBoundingClientRect();
      const box = element.querySelector<HTMLElement>("[data-ask-box], .app-composer-box")?.getBoundingClientRect();
      const width = Math.ceil(rect.right);
      const height = Math.ceil(rect.bottom);
      const topInset = box ? Math.max(0, Math.round(box.top)) : 12;
      const bottomInset = box ? Math.max(0, Math.round(height - box.bottom)) : 24;
      const leftInset = box ? Math.max(0, Math.round(box.left)) : 12;
      const rightInset = box ? Math.max(0, Math.round(width - box.right)) : 12;
      const size = `${modeRef.current}:${width}x${height}:${topInset},${bottomInset},${leftInset},${rightInset}`;
      if (height <= 0 || width <= 0 || size === toldSize.current) return;
      toldSize.current = size;
      tellFrame({ type: "size", width, height, topInset, bottomInset, leftInset, rightInset });
    };
    const report = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(measure);
    };
    measureNow.current = measure;
    measure();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);

  // Re-report size whenever mode, round, or layout changes even if dimensions happen to match.
  const shownRound = context?.round;
  useLayoutEffect(() => {
    if (shownRound === undefined && mode !== "dock") return;
    toldSize.current = "";
    measureNow.current();
  }, [shownRound, mode, placement, maxPanelHeight]);

  // Initial send from selection capsule: expands in place into the inline thread card!
  const sendInitial = async ({ body: question, invocationSelections: picked }: ComposerSendSnapshot) => {
    if (!context?.passage || sending.current) return;
    sending.current = true;
    setProblem(null);
    const { body, invocationSelections } = await askMessage(context.passage, question, picked, space?.id ?? null);
    const tempClientId = `optimistic:${Date.now()}`;
    setOptimisticMessages((prev) => [
      ...prev,
      {
        clientMessageId: tempClientId,
        body,
        sentAt: new Date().toISOString(),
        senderName: context.user.name || "You",
      },
    ]);
    setAwaitingFirstReply(true);
    setDockIndicator("busy");
    if (!activeThread) {
      setActiveThread({
        spaceId: context.spaceId ?? "",
        channelId: "",
        title: context.passage.label || "xMatrix",
      });
    }
    setMode("thread");
    tellFrame({ type: "mode", mode: "thread" });
    try {
      const sent = await ask<AskSendResult>("askSend", { body, invocationSelections });
      setActiveThread({
        spaceId: sent.spaceId,
        channelId: sent.channelId,
        title: sent.title || context.passage.label || "xMatrix",
      });
      setOptimisticMessages((prev) =>
        prev.map((item) => (item.clientMessageId === tempClientId
          ? { ...item, clientMessageId: sent.clientMessageId }
          : item)),
      );
    } catch (error) {
      setAwaitingFirstReply(false);
      setDockIndicator("idle");
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
    }
  };

  // Follow-up send inside the expanded inline thread card.
  const sendFollowUp = async ({ body: question, invocationSelections: picked }: ComposerSendSnapshot) => {
    if (!context || !activeThread?.channelId || sending.current) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    sending.current = true;
    setProblem(null);
    const tempClientId = `optimistic:${Date.now()}`;
    setOptimisticMessages((prev) => [
      ...prev,
      {
        clientMessageId: tempClientId,
        body: trimmed,
        sentAt: new Date().toISOString(),
        senderName: context.user.name || "You",
      },
    ]);
    setFollowUpRevision((current) => current + 1);
    setDockIndicator("busy");
    try {
      const sent = await ask<AskSendResult>("askSend", {
        body: trimmed,
        invocationSelections: picked,
        channelId: activeThread.channelId,
        spaceId: activeThread.spaceId,
        page: context.passage ?? undefined,
      });
      setOptimisticMessages((prev) =>
        prev.map((item) => (item.clientMessageId === tempClientId
          ? { ...item, clientMessageId: sent.clientMessageId }
          : item)),
      );
    } catch (error) {
      setDockIndicator("idle");
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
    }
  };

  // Synchronous sidePanel.open inside the user click gesture (◫ in card header or right-edge dock tab).
  const dockToSidePanel = useCallback(() => {
    if (typeof context?.tabId === "number") {
      void extension.sidePanel?.open({ tabId: context.tabId }).catch(() => undefined);
    }
    void ask("askDock", activeThread?.channelId
      ? { spaceId: activeThread.spaceId, channelId: activeThread.channelId }
      : {}).catch(() => undefined);
    setDockIndicator("idle");
    tellFrame({ type: "docked" });
  }, [activeThread, context?.tabId]);

  const minimizeToDock = useCallback(() => {
    setMode("dock");
    tellFrame({ type: "mode", mode: "dock" });
  }, []);

  const quoteToSidePanel = useCallback(() => {
    if (!context?.passage) return;
    void ask("askQuoteToPanel", context.passage).catch(() => undefined);
    tellFrame({ type: "close" });
  }, [context?.passage]);

  const passage = context?.passage;
  const frameClassName = mode === "dock" || mode === "quote"
    ? "xmatrix-app box-content w-max"
    : "xmatrix-app box-content w-[30rem]";
  const frameStyle = mode === "dock"
    ? { padding: "16px 0 20px 24px" }
    : mode === "quote"
      ? { padding: "12px 18px 20px" }
      : mode === "thread"
        ? { padding: "16px 24px 32px" }
        : maxPanelHeight
          ? { padding: "12px 12px 24px", ["--app-composer-panel-max-height" as string]: `${maxPanelHeight}px` }
          : { padding: "12px 12px 24px" };

  return (
    // Room around the surface for its shadow: the frame clips what falls outside it.
    // selection.js places the frame using the measured insets so the visible surface hugs its anchor.
    <div ref={frame} data-ask-surface="true" data-ask-mode={mode} className={frameClassName} style={frameStyle}>
      {mode === "dock" ? (
        <EdgeDockTab liveIndicator={dockIndicator} onOpenSidePanel={dockToSidePanel} />
      ) : mode === "quote" ? (
        context && passage ? <QuoteToPanelPill onQuote={quoteToSidePanel} /> : null
      ) : mode === "thread" && context ? (
        <GrantedAuthProvider token={context.token} user={context.user}>
          <MessageReferenceCatalogProvider catalog={referenceCatalog}>
            <InlineThreadCard
              thread={activeThread}
              messages={messages}
              optimisticMessages={optimisticMessages}
              confirmedClientIds={confirmedClientIds}
              busyAgent={busyAgent}
              awaitingFirstReply={awaitingFirstReply}
              space={space}
              token={context.token}
              user={context.user}
              error={problem}
              draftRevision={followUpRevision}
              onSendFollowUp={sendFollowUp}
              onDockToSidePanel={dockToSidePanel}
              onMinimize={minimizeToDock}
            />
          </MessageReferenceCatalogProvider>
        </GrantedAuthProvider>
      ) : context && passage ? (
        <GrantedAuthProvider token={context.token} user={context.user}>
          <MessageReferenceCatalogProvider catalog={referenceCatalog}>
            <Composer
              channel={null}
              draftIdentity="extension-ask"
              instanceTargetScope="none"
              startsConversation
              attachmentsEnabled={false}
              panelPlacement={placement}
              space={space}
              token={context.token}
              workspaces={[]}
              localContext={null}
              isJoined
              draft=""
              draftSeedRevision={context.round ?? 0}
              selectedWorkspaceId={null}
              replyTarget={null}
              attachments={[]}
              mentionInsertRequest={null}
              autoFocusRequest={0}
              error={problem}
              ariaLabel="Ask about this"
              sendTitle="Ask"
              sendIcon={<MessageCircle className="size-[19px]" strokeWidth={2.2} />}
              onDraftChange={() => undefined}
              onWorkspaceSelect={() => undefined}
              onCancelReply={() => undefined}
              onAttachmentsChange={() => undefined}
              onOpenAppsForSpace={() => undefined}
              onEscape={() => tellFrame({ type: "close" })}
              onSend={sendInitial}
            />
          </MessageReferenceCatalogProvider>
        </GrantedAuthProvider>
      ) : problem && <p role="alert" className="text-sm font-medium text-destructive">{problem}</p>}
    </div>
  );
}

createRoot(document.body).render(
  <>
    <LiquidGlassFilter />
    <LiquidGlassLensDefs />
    <Surface />
  </>,
);

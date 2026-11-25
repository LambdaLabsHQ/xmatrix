/**
 * The extension's on-page surface (apps/chrome-extension src/selection.js frames
 * this page beside a selection or docked flush to the right viewport edge).
 *
 * Four coherent states (Daniel 2026-11-24):
 * 1. `ask`: the App's floating glass composer capsule under selected text.
 * 2. `thread`: pressing Enter expands on Frame 0 straight into the real
 *    packaged xMatrix App (`./index.html?inline=1`) via its own 0ms optimistic
 *    `beginConversation` + `sendNewConversationMessage` flow.
 * 3. `dock`: minimizing the card (or closing the side panel on a page that
 *    already has a thread) docks a quiet warm-paper tab on the right edge with
 *    zero background fetches or eager App boot.
 * 4. `quote`: when Chrome's side panel is already open for this tab, selecting
 *    text offers a compact "Quote to side panel" pill instead of a second
 *    competing input box.
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { browserPageMetadata, WEB_PROXY_ROUTES, type AuthUser, type ChannelSnapshot, type SerializedSpace } from "@xmatrix/protocol";
import { API_ROUTES } from "xmatrix-extension:api-routes";
import { Composer } from "@/components/dashboard/workspace-composer-dialogs";
import { parseAppMentions } from "@/components/dashboard/mention-complete";
import { discussionTitle } from "@/components/dashboard/selection-discussion";
import { APP_CONNECTORS } from "@/lib/app-connectors";
import { askMessage } from "./ask-message";
import {
  EdgeDockTab,
  InlineThreadCard,
  QuoteToPanelPill,
  type InlineThreadTarget,
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
import { markExtensionAskSurface, type EmbedPendingMessage, type EmbedStartConversation } from "@/lib/extension-embed";
import { UserFacingProblem } from "@/lib/user-facing-error";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { installLocalApi } from "./local-api";

installLocalApi(API_ROUTES);

/** How long a minimized inline App stays warm on the active tab before releasing memory & WebSocket. */
const IDLE_RELEASE_MS = 120_000;
/** How long an open inline thread card stays warm after the user switches to another tab. */
const BACKGROUND_THREAD_RELEASE_MS = 180_000;

function readAskCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeAskCache(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable; live fetches still work normally.
  }
}

/**
 * Hydrates `@` agent registrations and launch targets synchronously from extension-origin
 * localStorage into TanStack Query so the `@` dropdown appears on the exact keystroke frame
 * (zero waterfall hesitation on newly opened tabs), while keeping the cache fresh in the background.
 */
function AskCompletionCacheBridge({ userId, spaceId }: { userId: string; spaceId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const hydratedKeyRef = useRef<string | null>(null);
  const scopeKey = spaceId ? `${userId}:${spaceId}` : null;

  if (scopeKey && hydratedKeyRef.current !== scopeKey && spaceId) {
    hydratedKeyRef.current = scopeKey;
    const regKey = xmatrixQueryKeys.domain({ userId }, "agent-registration-catalog", [spaceId]);
    if (!queryClient.getQueryData(regKey)) {
      const cachedReg = readAskCache<unknown>(`xmatrix:ask:reg:${scopeKey}`);
      if (cachedReg) queryClient.setQueryData(regKey, cachedReg, { updatedAt: Date.now() - 15_000 });
    }
    const targetKey = xmatrixQueryKeys.domain({ userId }, "space-launch-targets", [spaceId]);
    if (!queryClient.getQueryData(targetKey)) {
      const cachedTargets = readAskCache<unknown>(`xmatrix:ask:targets:${scopeKey}`);
      if (cachedTargets) queryClient.setQueryData(targetKey, cachedTargets, { updatedAt: Date.now() - 15_000 });
    }
  }

  useEffect(() => {
    if (!spaceId) return;
    const regCacheKey = `xmatrix:ask:reg:${userId}:${spaceId}`;
    const targetsCacheKey = `xmatrix:ask:targets:${userId}:${spaceId}`;
    const regQueryKey = JSON.stringify(xmatrixQueryKeys.domain({ userId }, "agent-registration-catalog", [spaceId]));
    const targetsQueryKey = JSON.stringify(xmatrixQueryKeys.domain({ userId }, "space-launch-targets", [spaceId]));
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const hash = JSON.stringify(event.query.queryKey);
      if (hash === regQueryKey && event.query.state.data) {
        writeAskCache(regCacheKey, event.query.state.data);
      } else if (hash === targetsQueryKey && event.query.state.data) {
        writeAskCache(targetsCacheKey, event.query.state.data);
      }
    });
  }, [queryClient, userId, spaceId]);

  return null;
}

type SurfaceMode = "ask" | "thread" | "dock" | "quote";

type OutboxFailure = {
  clientMessageId: string;
  title?: string;
  preview?: string;
  error?: string;
  failedAt: number;
};

/** What the service worker hands this page: the session, the passage it was opened on, the Space and any page thread. */
type AskContext = {
  token: string;
  user: AuthUser;
  spaceId: string | null;
  passage: { text: string; label: string; href: string } | null;
  thread?: InlineThreadTarget | null;
  outboxFailures?: OutboxFailure[];
  panelOpen?: boolean;
  /** The tab the box is on: its panel is the one that opens. */
  tabId: number | null;
  /** The selection it was read for. */
  round?: number;
};

type Extension = {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string; code?: string } | undefined> };
  sidePanel?: { open: (options: { tabId: number }) => Promise<void> };
};
const extension = (globalThis as unknown as { chrome: Extension }).chrome;

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
    | { type: "panel"; open: boolean }
    | { type: "mode"; mode: "ask" | "thread" | "dock" }
    | { type: "docked" }
    | { type: "close" },
) {
  window.parent.postMessage({ xmatrixAsk: true, ...message }, "*");
}

function Surface() {
  // Each selection increments round to fetch the latest passage; ask draft stays intact across re-selections (Item 6).
  const [round, setRound] = useState(0);
  const [mode, setMode] = useState<SurfaceMode>("ask");
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | null>(null);
  const [context, setContext] = useState<AskContext | null>(null);
  const [selfTabId, setSelfTabId] = useState<number | null>(null);
  const [livePage, setLivePage] = useState<{ label: string; href: string } | null>(null);
  const [activeThread, setActiveThread] = useState<InlineThreadTarget | null>(null);
  const [pendingStart, setPendingStart] = useState<EmbedStartConversation | null>(null);
  const [pendingMessage, setPendingMessage] = useState<EmbedPendingMessage | null>(null);
  const [expandingFromAsk, setExpandingFromAsk] = useState(false);
  const [morphStartHeight, setMorphStartHeight] = useState<number>(52);
  // On-demand App warm-up (B5): never boots in idle dock mode; warms on drag-start/ask-focus/thread-open,
  // and releases automatically on side-panel open, background tab, or idle timeout.
  const [warmApp, setWarmApp] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [space, setSpace] = useState<SerializedSpace | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outboxFailures, setOutboxFailures] = useState<OutboxFailure[]>([]);
  const [askDraftSeed, setAskDraftSeed] = useState("");
  const [askDraftSeedRevision, setAskDraftSeedRevision] = useState(0);
  const sending = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const toldSize = useRef("");
  const measureNow = useRef<() => void>(() => undefined);
  const modeRef = useRef<SurfaceMode>(mode);
  modeRef.current = mode;
  const contextRef = useRef<AskContext | null>(context);
  contextRef.current = context;

  const resetAskDraft = useCallback((seed = "") => {
    setAskDraftSeed(seed);
    setAskDraftSeedRevision((current) => current + 1);
  }, []);

  const pendingSendsRef = useRef(0);
  // Covers the brief window after Enter before the embedded App posts its first
  // `pending-sends: 1` update, so clicking ◫ right after Enter never releases early.
  const startInFlightRef = useRef(false);
  const startReportedBusyRef = useRef(false);
  const releaseDeferredRef = useRef(false);
  const releaseCapTimerRef = useRef<number | null>(null);

  const releaseInlineAppNow = useCallback(() => {
    releaseDeferredRef.current = false;
    startInFlightRef.current = false;
    startReportedBusyRef.current = false;
    if (releaseCapTimerRef.current !== null) {
      window.clearTimeout(releaseCapTimerRef.current);
      releaseCapTimerRef.current = null;
    }
    setWarmApp(false);
    setPendingStart(null);
    setPendingMessage(null);
    setExpandingFromAsk(false);
  }, []);

  const requestReleaseInlineApp = useCallback(() => {
    if (pendingSendsRef.current <= 0 && !startInFlightRef.current) {
      releaseInlineAppNow();
      return;
    }
    releaseDeferredRef.current = true;
    if (releaseCapTimerRef.current === null) {
      releaseCapTimerRef.current = window.setTimeout(() => {
        releaseInlineAppNow();
      }, 45_000);
    }
  }, [releaseInlineAppNow]);

  const handlePendingSendsChange = useCallback((count: number) => {
    pendingSendsRef.current = count;
    if (count > 0) {
      startReportedBusyRef.current = true;
      return;
    }
    if (startInFlightRef.current && startReportedBusyRef.current) {
      startInFlightRef.current = false;
      startReportedBusyRef.current = false;
    }
    if (count <= 0 && !startInFlightRef.current && releaseDeferredRef.current) {
      releaseInlineAppNow();
    }
  }, [releaseInlineAppNow]);

  useEffect(() => () => {
    if (releaseCapTimerRef.current !== null) {
      window.clearTimeout(releaseCapTimerRef.current);
      releaseCapTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as {
        xmatrixAsk?: unknown;
        mode?: unknown;
        placement?: unknown;
        maxPanelHeight?: unknown;
        hidden?: unknown;
        title?: unknown;
        href?: unknown;
      } | null;
      if (data?.xmatrixAsk === "prepared" || data?.xmatrixAsk === "layout") {
        if (data.placement === "above" || data.placement === "below") setPlacement(data.placement);
        if (typeof data.maxPanelHeight === "number" && Number.isFinite(data.maxPanelHeight) && data.maxPanelHeight > 0) {
          setMaxPanelHeight(data.maxPanelHeight);
        }
        if (data.xmatrixAsk === "prepared") {
          setLivePage(null);
          setExpandingFromAsk(false);
          const nextMode: SurfaceMode = data.mode === "quote" ? "quote" : data.mode === "thread" ? "thread" : "ask";
          if (nextMode === "thread") {
            setPendingStart(null);
            setPendingMessage(null);
            setWarmApp(true);
          }
          setMode(nextMode);
          setRound((current) => current + 1);
        }
      } else if (data?.xmatrixAsk === "prewarm") {
        // User started dragging a selection on a tab with a bound thread: pre-warm the real App during drag (Item 4).
        setWarmApp(true);
        if (!contextRef.current) {
          void ask<AskContext>("askContext", { optionalPassage: true }).then((next) => {
            markExtensionAskSurface(next.token);
            setContext((current) => current ?? { ...next, round: 0 });
            if (next.thread) {
              setActiveThread((current) => current ?? next.thread ?? null);
            }
          }).catch(() => undefined);
        }
      } else if (data?.xmatrixAsk === "page-updated" && typeof data.href === "string" && data.href) {
        // SPA navigation / title change in the same tab while the card stays open (Item 2).
        setLivePage({ label: typeof data.title === "string" ? data.title : "", href: data.href });
      } else if (data?.xmatrixAsk === "reset-draft") {
        resetAskDraft("");
      } else if (data?.xmatrixAsk === "dock") {
        setExpandingFromAsk(false);
        setMode("dock");
        setRound((current) => current + 1);
      } else if (data?.xmatrixAsk === "release") {
        // Side panel displayed the conversation or tab no longer needs an in-page App:
        // release once any in-flight send finishes so nothing is aborted mid-flight.
        requestReleaseInlineApp();
      } else if (data?.xmatrixAsk === "visibility") {
        setTabHidden(data.hidden === true);
      }
    };
    window.addEventListener("message", onMessage);
    const onPageHide = () => {
      void extension.runtime.sendMessage({ type: "outboxFlushTab", args: { source: "inline" } }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onPageHide);
    // Local-only tabId lookup (zero network/Hub traffic) so clicking the idle dock tab opens sidePanel synchronously.
    void ask<{ tabId: number }>("askTabId").then((res) => {
      if (typeof res?.tabId === "number") setSelfTabId(res.tabId);
    }).catch(() => undefined);
    tellFrame({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [requestReleaseInlineApp, resetAskDraft]);

  // Release warm App when docked/idle or when an open thread card sits in a background tab for 3 minutes (B5).
  // Automatically restore when switching back to a tab whose thread card is still open.
  useEffect(() => {
    if (mode === "thread") {
      if (!tabHidden) {
        if (!warmApp) setWarmApp(true);
        return;
      }
      if (!warmApp) return;
      const timer = window.setTimeout(() => setWarmApp(false), BACKGROUND_THREAD_RELEASE_MS);
      return () => window.clearTimeout(timer);
    }
    if (!warmApp) return;
    if (tabHidden) {
      if (pendingSendsRef.current > 0 || startInFlightRef.current) return;
      setWarmApp(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (pendingSendsRef.current <= 0 && !startInFlightRef.current) setWarmApp(false);
    }, IDLE_RELEASE_MS);
    return () => window.clearTimeout(timer);
  }, [warmApp, mode, tabHidden]);

  useEffect(() => {
    if (round === 0) return;
    // In idle dock mode on page load we only need the lightweight edge tab — do NOT trigger
    // token/context roundtrips or mount the embedded App until the user interacts (B1/B3).
    if (modeRef.current === "dock") {
      sending.current = false;
      setProblem(null);
      return;
    }
    let live = true;
    sending.current = false;
    setProblem(null);
    ask<AskContext>("askContext", { optionalPassage: false }).then((next) => {
      if (!live) return;
      markExtensionAskSurface(next.token);
      setContext({ ...next, round });
      setOutboxFailures(Array.isArray(next.outboxFailures) ? next.outboxFailures : []);
      setActiveThread((current) => {
        if (!next.thread) return null;
        return current?.channelId === next.thread.channelId ? current : next.thread;
      });
      if (!next.thread && modeRef.current === "thread") {
        setMode("ask");
        tellFrame({ type: "mode", mode: "ask" });
      }
      void ask<{ token: string } | null>("session").then((session) => {
        if (!live || !session?.token || session.token === next.token) return;
        markExtensionAskSurface(session.token);
        setContext((current) => (current ? { ...current, token: session.token } : current));
      }).catch(() => undefined);
    }).catch((error: unknown) => {
      if (!live) return;
      if ((error as { code?: unknown }).code === "signed_out") setProblem((error as Error).message);
      else tellFrame({ type: "close" });
    });
    return () => { live = false; };
  }, [round]);

  // Only hydrate Space / channel references while the `ask` capsule is active (never in dock/quote/thread modes, B3).
  const token = context?.token;
  const userId = context?.user?.id;
  const spaceId = activeThread?.spaceId || context?.spaceId || null;
  const effectiveSpace = useMemo<SerializedSpace | null>(() => {
    if (space && (!spaceId || space.id === spaceId)) return space;
    if (!spaceId) return null;
    if (userId) {
      const cached = readAskCache<SerializedSpace>(`xmatrix:ask:space:${userId}:${spaceId}`);
      if (cached?.id === spaceId) return cached;
    }
    return { id: spaceId, name: "" } as SerializedSpace;
  }, [space, spaceId, userId]);

  const [channels, setChannels] = useState<readonly ChannelReference[]>([]);
  const effectiveChannels = useMemo<readonly ChannelReference[]>(() => {
    if (channels.length > 0) return channels;
    if (userId && spaceId) {
      return readAskCache<ChannelReference[]>(`xmatrix:ask:channels:${userId}:${spaceId}`) ?? [];
    }
    return [];
  }, [channels, userId, spaceId]);

  useEffect(() => {
    if (mode !== "ask" || !token || !spaceId) return;
    let live = true;
    void xmatrixApiRequest<{ spaces?: SerializedSpace[] }>({ url: "/api/xmatrix/spaces", token })
      .then(({ spaces = [] }) => {
        if (!live) return;
        const found = spaces.find((item) => item.id === spaceId) ?? null;
        if (found) {
          setSpace(found);
          if (userId) writeAskCache(`xmatrix:ask:space:${userId}:${spaceId}`, found);
        }
      })
      .catch(() => undefined);
    void xmatrixApiRequest<{ channels?: ChannelSnapshot[] }>({ url: WEB_PROXY_ROUTES.channels, token })
      .then(({ channels: fetched = [] }) => {
        if (!live) return;
        const refs = channelReferences([], fetched.filter((channel) => channel.spaceId === spaceId));
        setChannels(refs);
        if (userId) writeAskCache(`xmatrix:ask:channels:${userId}:${spaceId}`, refs);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [mode, token, spaceId, userId]);

  const referenceCatalog = useMemo<MessageReferenceCatalog | null>(() => effectiveChannels.length
    ? { channels: effectiveChannels, channelActivityMs: () => 0, onOpenChannel: () => undefined } : null, [effectiveChannels]);

  // Measure the surface and notify selection.js of two-tier completion panel state.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    let scheduled = false;
    let live = true;
    let lastPanelOpen = false;
    const syncPanelState = () => {
      if (!live) return;
      const open = modeRef.current === "ask"
        && element.querySelector(".app-composer-box-mentions-open, .app-composer-box-morphing") !== null;
      if (open === lastPanelOpen) return;
      lastPanelOpen = open;
      tellFrame({ type: "panel", open });
    };
    const measure = () => {
      scheduled = false;
      if (!live) return;
      syncPanelState();
      const rect = element.getBoundingClientRect();
      const box = element.querySelector<HTMLElement>("[data-ask-box], .app-composer-box")?.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      const isPinnedSurface = modeRef.current === "ask" || modeRef.current === "thread";
      const topInset = isPinnedSurface ? 12 : box ? Math.max(0, Math.round(box.top - rect.top)) : 12;
      const bottomInset = isPinnedSurface ? 36 : box ? Math.max(0, Math.round(rect.bottom - box.bottom)) : 24;
      const leftInset = isPinnedSurface ? 24 : box ? Math.max(0, Math.round(box.left - rect.left)) : 12;
      const rightInset = isPinnedSurface ? 24 : box ? Math.max(0, Math.round(rect.right - box.right)) : 12;
      const size = `${modeRef.current}:${width}x${height}:${topInset},${bottomInset},${leftInset},${rightInset}`;
      if (height <= 0 || width <= 0 || size === toldSize.current) return;
      toldSize.current = size;
      tellFrame({ type: "size", width, height, topInset, bottomInset, leftInset, rightInset });
    };
    const report = () => {
      syncPanelState();
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(measure);
    };
    measureNow.current = measure;
    measure();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    const mutations = new MutationObserver(syncPanelState);
    mutations.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      live = false;
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  const shownRound = context?.round;
  useLayoutEffect(() => {
    if (shownRound === undefined && mode !== "dock") return;
    toldSize.current = "";
    measureNow.current();
  }, [shownRound, mode, placement, maxPanelHeight]);

  // 0ms Enter expand (Item 1 & Item 5): immediately expand the card on Frame 0 and let the
  // pre-warmed real App run its own deterministic `beginConversation` + `sendNewConversationMessage`.
  const sendInitial = async ({ body: question, invocationSelections: picked }: ComposerSendSnapshot) => {
    if (!context?.passage || sending.current) return;
    sending.current = true;
    setProblem(null);
    const measuredBoxHeight = frame.current?.querySelector<HTMLElement>(".app-composer-box")?.getBoundingClientRect().height;
    setMorphStartHeight(measuredBoxHeight && measuredBoxHeight > 30 ? Math.round(measuredBoxHeight) : 52);

    let body: string;
    let invocationSelections: ComposerSendSnapshot["invocationSelections"];
    try {
      const built = await askMessage(context.passage, question, picked, effectiveSpace?.id ?? null);
      body = built.body;
      invocationSelections = built.invocationSelections;
    } catch (error) {
      sending.current = false;
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }

    const title = discussionTitle(context.passage.text || context.passage.label);
    const makeId = (prefix: string) => (
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    const startId = makeId("start");
    const requestKey = makeId("req");
    const clientMessageId = makeId("msg");
    const appMentions = parseAppMentions(body, APP_CONNECTORS);
    const pageMeta = browserPageMetadata({ title: context.passage.label, href: context.passage.href });
    // Register durably with the extension service worker BEFORE handing off to the
    // embedded App, so closing or navigating the tab even 50ms after Enter never drops it.
    void ask("outboxRegister", {
      clientMessageId,
      userId: context.user.id,
      ...(typeof (context.tabId ?? selfTabId) === "number" ? { tabId: context.tabId ?? selfTabId } : {}),
      source: "inline",
      ...(effectiveSpace?.id ? { spaceId: effectiveSpace.id } : {}),
      channelCreate: {
        requestKey,
        ...(effectiveSpace?.id ? { spaceId: effectiveSpace.id } : {}),
        name: title,
        mode: "open",
        memberName: context.user.name || context.user.email || "Human",
        metadata: { autoName: true, createdBy: "chrome-extension" },
      },
      body,
      ...(invocationSelections ? { invocationSelections } : {}),
      metadata: pageMeta,
      ...(appMentions.length > 0 ? { appMentions } : {}),
      title,
      href: context.passage.href,
    }).catch(() => undefined);

    startInFlightRef.current = true;
    startReportedBusyRef.current = false;
    setActiveThread({
      spaceId: effectiveSpace?.id ?? "",
      channelId: "",
      title,
    });
    setPendingMessage(null);
    setPendingStart({
      id: startId,
      body,
      requestKey,
      clientMessageId,
      rawQuestion: question,
      title,
      spaceId: effectiveSpace?.id ?? undefined,
      href: context.passage.href,
      label: context.passage.label,
      invocationSelections,
    });
    setWarmApp(true);
    setExpandingFromAsk(true);
    setMode("thread");
    tellFrame({ type: "mode", mode: "thread" });
    resetAskDraft("");
    sending.current = false;
  };

  // Synchronous sidePanel.open inside the user click gesture (◫ in card header or right-edge dock tab).
  // Hide the inline card visually right away, but keep the inline App alive until the side panel
  // reports it has displayed the conversation (and any in-flight send settles).
  const dockToSidePanel = useCallback((options?: { messageId?: string }) => {
    const tabId = context?.tabId ?? selfTabId;
    void ask("askDock", {
      ...(activeThread?.channelId ? { spaceId: activeThread.spaceId, channelId: activeThread.channelId } : {}),
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    }).catch(() => undefined);
    if (typeof tabId === "number") {
      void extension.sidePanel?.open({ tabId }).catch(() => undefined);
    }
    tellFrame({ type: "docked" });
  }, [activeThread, context?.tabId, selfTabId]);

  const minimizeToDock = useCallback(() => {
    setExpandingFromAsk(false);
    setMode("dock");
    tellFrame({ type: "mode", mode: "dock" });
  }, []);

  const handleThreadBound = useCallback((bound: InlineThreadTarget) => {
    setActiveThread((current) => ({
      spaceId: bound.spaceId,
      channelId: bound.channelId,
      title: bound.title || current?.title || "xMatrix",
      snapshot: bound.snapshot ?? current?.snapshot ?? null,
    }));
  }, []);

  const handleThreadCleared = useCallback((unsentDraft?: string, errorMessage?: string) => {
    startInFlightRef.current = false;
    startReportedBusyRef.current = false;
    setActiveThread(null);
    setPendingStart(null);
    setPendingMessage(null);
    setExpandingFromAsk(false);
    setWarmApp(false);
    if (typeof errorMessage === "string" && errorMessage.trim()) setProblem(errorMessage);
    if (typeof unsentDraft === "string" && unsentDraft.trim()) {
      resetAskDraft(unsentDraft);
    }
    if (modeRef.current === "thread" && (context?.passage?.text?.trim() || (typeof unsentDraft === "string" && unsentDraft.trim()))) {
      setMode("ask");
      tellFrame({ type: "mode", mode: "ask" });
    } else {
      tellFrame({ type: "close" });
    }
  }, [context?.passage?.text, resetAskDraft]);

  const quoteToSidePanel = useCallback(() => {
    if (!context?.passage) return;
    void ask("askQuoteToPanel", context.passage).catch(() => undefined);
    tellFrame({ type: "close" });
  }, [context?.passage]);

  const dismissOutboxFailures = useCallback(() => {
    setOutboxFailures([]);
    void ask("dismissOutboxFailures").catch(() => undefined);
  }, []);

  const outboxFailureSummary = useMemo(() => {
    if (outboxFailures.length === 0) return null;
    const latest = outboxFailures[outboxFailures.length - 1];
    const headline = outboxFailures.length === 1
      ? "A previous question could not be sent"
      : `${outboxFailures.length} previous questions could not be sent`;
    const snippet = latest?.preview || latest?.title || "";
    return snippet ? `${headline}: ${snippet}` : headline;
  }, [outboxFailures]);

  const passage = context?.passage ?? null;
  const effectivePassage = useMemo(() => {
    if (!livePage) return passage;
    return {
      text: passage?.text ?? "",
      label: livePage.label || passage?.label || "",
      href: livePage.href,
    };
  }, [livePage, passage]);

  const mountThreadFrame = Boolean(context && (mode === "thread" || warmApp));
  const frameClassName = mode === "dock" || mode === "quote"
    ? "xmatrix-app box-content w-max"
    : "xmatrix-app box-content w-[30rem]";
  const frameStyle = mode === "dock"
    ? { padding: "16px 0 20px 24px" }
    : mode === "quote"
      ? { padding: "12px 18px 20px" }
      : mode === "thread"
        ? { padding: "12px 24px 36px 24px" }
        : maxPanelHeight
          ? { padding: "12px 24px 36px 24px", ["--app-composer-panel-max-height" as string]: `${maxPanelHeight}px` }
          : { padding: "12px 24px 36px 24px" };

  const stageStyle = mode === "ask" || mode === "thread"
    ? {
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column" as const,
        justifyContent: placement === "above" ? "flex-end" : "flex-start",
        alignItems: "flex-start",
      }
    : undefined;

  return (
    <div
      style={stageStyle}
      onFocusCapture={() => {
        // Focusing the ask capsule signals the user is about to ask: pre-warm the real App quietly off-screen.
        if (modeRef.current === "ask" && !warmApp) setWarmApp(true);
      }}
      onMouseDown={(event) => {
        if (modeRef.current !== "ask") return;
        if (event.target instanceof Element && event.target.closest(".app-composer-box")) return;
        resetAskDraft("");
        tellFrame({ type: "close" });
      }}
    >
      <div ref={frame} data-ask-surface="true" data-ask-mode={mode} className={frameClassName} style={frameStyle}>
        {(mode === "ask" || mode === "thread") && outboxFailureSummary ? (
          <div
            role="alert"
            className="mb-2 flex items-center gap-2 rounded-xl border border-destructive/20 bg-white px-3 py-1.5 text-xs text-destructive shadow-sm"
          >
            <span className="min-w-0 flex-1 truncate">{outboxFailureSummary}</span>
            <button
              type="button"
              onClick={dismissOutboxFailures}
              aria-label="Dismiss undelivered message notice"
              className="shrink-0 cursor-pointer rounded px-1 text-destructive/75 hover:bg-destructive/10 hover:text-destructive"
            >
              ×
            </button>
          </div>
        ) : null}
        {mode === "dock" ? (
          <EdgeDockTab onOpenSidePanel={dockToSidePanel} />
        ) : mode === "quote" ? (
          context && passage ? <QuoteToPanelPill onQuote={quoteToSidePanel} /> : null
        ) : mode === "ask" && context && passage ? (
          <GrantedAuthProvider token={context.token} user={context.user}>
            <AskCompletionCacheBridge userId={context.user.id} spaceId={effectiveSpace?.id} />
            <MessageReferenceCatalogProvider catalog={referenceCatalog}>
              <Composer
                channel={null}
                draftIdentity="extension-ask"
                instanceTargetScope="none"
                startsConversation
                attachmentsEnabled={false}
                showSelectedAgentsStrip={false}
                panelPlacement={placement}
                space={effectiveSpace}
                token={context.token}
                workspaces={[]}
                localContext={null}
                isJoined
                draft={askDraftSeed}
                draftSeedRevision={askDraftSeedRevision}
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
                onEscape={() => {
                  resetAskDraft("");
                  tellFrame({ type: "close" });
                }}
                onSend={sendInitial}
              />
            </MessageReferenceCatalogProvider>
          </GrantedAuthProvider>
        ) : mode !== "thread" && problem ? (
          <p role="alert" className="text-sm font-medium text-destructive">{problem}</p>
        ) : null}
        {mountThreadFrame && context ? (
          <InlineThreadCard
            visible={mode === "thread"}
            expanding={expandingFromAsk}
            thread={activeThread}
            placement={placement}
            morphStartHeight={morphStartHeight}
            pendingStart={pendingStart}
            pendingMessage={pendingMessage}
            quotePassage={mode === "thread" && !expandingFromAsk && passage?.text?.trim()
              ? { ...passage, round: context.round ?? round }
              : null}
            passage={effectivePassage}
            token={context.token}
            user={context.user}
            tabId={context.tabId ?? selfTabId}
            error={problem}
            askExtension={ask}
            onDockToSidePanel={dockToSidePanel}
            onMinimize={minimizeToDock}
            onThreadBound={handleThreadBound}
            onThreadCleared={handleThreadCleared}
            onPendingSendsChange={handlePendingSendsChange}
          />
        ) : null}
      </div>
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

"use client";
import { loadImage as loadImageForClipboard, canvasToBlob as canvasToBlobForClipboard } from "./image-canvas";

import type {
  AgentTraceTarget,
  ChannelNavItemProps,
  ComposerSendSnapshot,
  TimelineItem,
} from "./workspace-shell-message-model";
import type { MessageAttachmentMediaStore } from "./message-attachment-media-store";

import {
  timelineMessagesEqual,
} from "./workspace-shell-message-model";

export type {
  AgentTraceTarget,
  ChannelNavItemProps,
  ComposerSendSnapshot,
  TimelineItem,
  ThreadReplyParticipant,
} from "./workspace-shell-message-model";

export {
  replyPreviewSequence,
  replyPreviewsEqual,
  timelineMessagesEqual,
} from "./workspace-shell-message-model";

import {
  AGENT_BUSY_TRACE_STALE_MS,
  DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX,
  DESKTOP_SIDEBAR_MAX_WIDTH_PX,
  DESKTOP_SIDEBAR_MIN_WIDTH_PX,
  DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY,
  MAX_COMPRESSED_IMAGE_DIMENSION,
  RELAY_CLIENT_PROFILE_STORAGE_KEY,
} from "./workspace-shell-constants";

import {
  channelAttachmentKindForMimeType,
} from "./workspace-shell-formatters";
import {
  pointerActivationAlreadyHandled,
  pointerActivationIsPending,
  rememberPointerActivation,
} from "./pointer-activation-guard";

import {
  channelMembersByPresence,
  isOlderThan,
  latestAgentWorkEvent,
  memberPresence,
  presenceStatusLabel,
  relativeTime,
} from "./workspace-shell-presence";

export { agentInstancePresenceLabel } from "./workspace-shell-presence";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";

import { parseAppMentions } from "@/components/dashboard/mention-complete";

import {
  agentTraceInstanceIds,
} from "@/components/dashboard/agent-trace-target";

import {
  getDesktopBridge,
} from "@/lib/desktop/bridge";

import { ProductMessageAttachmentMediaClient } from "@/lib/relay-v2/product-message-attachment-media";
import type { ProductTailCacheStoreNamespace } from "@/lib/relay-v2/product-tail-cache-store";

import { DEFAULT_HUB_URL, normalizeHubUrl, lowercaseHex, type MessageSearchPage } from "@xmatrix/protocol";

import type {
  ChannelAttachment,
  ChannelMessage,
  ChannelMemberPresence,
  MessageSender,
  ObservabilityEvent,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedMachineDaemon,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";
import { xmatrixRawResponse } from "@/lib/query/api-client";
import type { QuestionnaireAnswer } from "./questionnaire-card";

// Split from workspace-shell-helpers.tsx (size guard)

// Semantic module extracted from workspace-app-shell (AST-safe)

export let inMemoryRelayClientProfileId: string | undefined;

export function browserRelayClientProfileId(): string {
  if (inMemoryRelayClientProfileId) return inMemoryRelayClientProfileId;
  if (typeof window === "undefined") throw new Error("browser profile is unavailable");
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const create = () => `browser-profile:${lowercaseHex(bytes)}`;
  try {
    const existing = window.localStorage.getItem(RELAY_CLIENT_PROFILE_STORAGE_KEY);
    if (existing && /^browser-profile:[a-f0-9]{32}$/u.test(existing)) {
      inMemoryRelayClientProfileId = existing;
      return existing;
    }
    const created = create();
    window.localStorage.setItem(RELAY_CLIENT_PROFILE_STORAGE_KEY, created);
    inMemoryRelayClientProfileId = created;
    return created;
  } catch {
    inMemoryRelayClientProfileId = create();
    return inMemoryRelayClientProfileId;
  }
}

/** Names this browser profile's durable tail cache for one user of one Hub. */
export function browserTailCacheNamespace(userId: string): ProductTailCacheStoreNamespace {
  return {
    hubOrigin: new URL(normalizeHubUrl(
      process.env.NEXT_PUBLIC_XMATRIX_HUB_URL || DEFAULT_HUB_URL
    )).origin,
    userId,
    clientProfileId: browserRelayClientProfileId(),
  };
}

export function clampDesktopSidebarWidth(value: number): number {
  return Math.max(DESKTOP_SIDEBAR_MIN_WIDTH_PX, Math.min(DESKTOP_SIDEBAR_MAX_WIDTH_PX, Math.round(value)));
}

export function readStoredDesktopSidebarWidth(): number {
  if (typeof window === "undefined") return DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX;
  // Read the raw string first. `Number(null)` and `Number("")` are both 0, and
  // 0 is finite, so coercing before the absent check sent every sidebar the
  // user had never dragged through the clamp and out at the *minimum* width.
  // The default was unreachable: only a stored value could ever produce it.
  const stored = window.localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY);
  if (stored === null || stored.trim() === "") return DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clampDesktopSidebarWidth(parsed) : DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX;
}

export type OutgoingMessage = {
  clientMessageId: string;
  channelId: string;
  body: string;
  invocationSelections?: ComposerSendSnapshot["invocationSelections"];
  summonIntents?: ComposerSendSnapshot["summonIntents"];
  attachments: ChannelAttachment[];
  replyToMessageId?: string;
  replyTo?: TimelineItem["replyTo"];
  appMentions: ReturnType<typeof parseAppMentions>;
  sentAt: string;
  /**
   * `unconfirmed` means the send passed its deadline with the result unknown —
   * the write may well have committed. It is neither `pending` (which claims the
   * request is still in flight) nor `failed` (which claims it was not written),
   * and it converges when the committed message arrives by `clientMessageId`.
   */
  status: "pending" | "unconfirmed" | "failed";
  error?: string;
};

/* ThreadReplyParticipant owned by message-model */

export type SpaceInviteRole = "admin" | "member" | "viewer";

export type SpaceInviteResult = {
  invite?: { url?: string; role?: SpaceInviteRole | string };
  sent?: string[];
  failed?: Array<{ email: string; error: string }>;
};

export type SpaceMemberActionResult = {
  space?: SerializedSpace;
};

export type {
  LlmQuotaUsage,
  LlmUsage,
  LocalManagedAgent,
  UsageLimitSummary,
} from "./workspace-shell-domain-types";

export type ChannelPinState = {
  pinnedChannelIds: string[];
  orderedChannelIds: string[];
};

export type ChannelPinLookup = {
  pinnedChannelIds: Set<string>;
};

export type WorkspaceMessageSearch = (
  query: string,
  resumeToken?: string,
  filters?: { channelId?: string; from?: string },
) => Promise<MessageSearchPage>;

export type ChannelCreateMode = "open" | "closed";

export type MachineSummary = {
  id: string;
  name: string;
  /** The owner's Machine id, when a daemon of this owner reported it. */
  machineId?: string;
  /** For a WSL distribution, the Machine id of its Windows host. */
  parentMachineId?: string;
  /** Its owner keeps it out of automatic assignment; absent, it takes part. */
  autoAssign?: false;
  status: "online" | "offline";
  daemon?: SerializedMachineDaemon;
  daemonVersion?: string;
  cliVersion?: string;
  appVersion?: string;
  workspaces: SerializedWorkspace[];
  lastSeenAt?: string;
  /** Agent Runs starting or running on it, when its daemon list reports them. */
  activeRuns?: number;
};

export type ChannelHistoryCacheEntry = {
  messages: ChannelMessage[];
  hasOlderMessages: boolean;
  cachedAt: number;
};

/** Which user, Channel and history revision the presented rows were read for. */
export type HistoryRenderAuthority = {
  userId: string;
  channelId: string;
  historyRevision: number;
};

export type MobileListFixture = {
  channels: SerializedChannel[];
  spaces: SerializedSpace[];
  readCounts: Record<string, number>;
  history: Record<string, ChannelMessage[]>;
};

export function mobileListFixtureEnabled(pathname: string): boolean {
  return process.env.NEXT_PUBLIC_XMATRIX_MOBILE_LIST_FIXTURE === "1" &&
    (pathname === "/app/fixture-space" || pathname.startsWith("/app/fixture-space/"));
}

export function createMobileListFixture(pathname: string): MobileListFixture | null {
  if (!mobileListFixtureEnabled(pathname)) return null;

  const now = Date.now();
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const space: SerializedSpace = {
    id: "fixture-space",
    name: "Lambda Labs",
    ownerId: "mock-user",
    members: [
      {
        userId: "mock-user",
        email: "mock@xmatrix.local",
        name: "Yiming",
        role: "owner",
        joinedAt: iso(24 * 60),
      },
    ],
    createdAt: iso(24 * 60),
    updatedAt: iso(2),
  };
  const sender = (label: string, kind: MessageSender["kind"] = "agent"): MessageSender => ({
    identityId: kind === "agent" ? `agent:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "user:mock-user",
    kind,
    label,
    userId: kind === "agent" ? "agent-owner" : "mock-user",
    email: kind === "agent" ? "agent@xmatrix.local" : "mock@xmatrix.local",
    agentName: kind === "agent" ? label : undefined,
  });
  const message = (
    channelId: string,
    sequence: number,
    minutesAgo: number,
    label: string,
    body: string,
    kind: MessageSender["kind"] = "agent"
  ): ChannelMessage => ({
    messageId: `${channelId}:m${sequence}`,
    channelId,
    sequence,
    from: sender(label, kind),
    body,
    sentAt: iso(minutesAgo),
  });
  const channel = (
    id: string,
    name: string,
    minutesAgo: number,
    preview: string,
    options: Partial<SerializedChannel> & {
      from?: string;
      unread?: number;
      members?: Record<string, ChannelMemberPresence>;
    } = {}
  ): SerializedChannel => ({
    id,
    spaceId: space.id,
    name,
    topic: options.topic,
    summary: options.summary,
    mode: options.mode || "open",
    messageCount: options.messageCount || 0,
    lastMessage: {
      messageId: `${id}:last`,
      from: sender(options.from || "Codex"),
      bodyPreview: preview,
      sentAt: iso(minutesAgo),
    },
    attention: options.unread
      ? {
          channelId: id,
          unreadAttentionCount: options.unread,
          primaryTriggerKind: "mention",
          updatedAt: iso(minutesAgo),
        }
      : undefined,
    memberPresence: options.members || {
      "agent:codex": {
        kind: "agent",
        label: "Codex",
        activity: "Reviewing mobile UX",
        instances: [
          {
            id: `${id}:codex:1`,
            channelInstanceId: "1",
            label: "codex:1",
            connectedAt: iso(minutesAgo + 8),
            lastSeenAt: iso(1),
            status: "busy",
            activity: "Reviewing mobile UX",
            workspaceName: "xmatrix-mobile-ux",
          },
        ],
      },
      "agent:claude": {
        kind: "agent",
        label: "Claude",
        activity: "Watching review",
        instances: [
          {
            id: `${id}:claude:1`,
            channelInstanceId: "1",
            label: "claude:1",
            connectedAt: iso(minutesAgo + 12),
            lastSeenAt: iso(3),
            status: "online",
            activity: "Watching review",
            workspaceName: "xmatrix-mobile-ux",
          },
        ],
      },
    },
    metadata: options.metadata,
    createdBy: "mock-user",
    createdAt: iso(24 * 60),
    updatedAt: iso(minutesAgo),
  });

  const channels = [
    channel("xmatrix", "x-matrix", 2, "移动端 UX 复验集中在列表、详情和原生壳观感。", {
      unread: 4,
      from: "Yiming",
      topic: "Mobile UX review",
    }),
    channel("launch", "移动端的体验,设计,ux 需要彻底重构", 2, "Mobile list pass is ready for screenshot review.", {
      unread: 12,
      from: "Codex",
      topic: "Daily product execution",
    }),
    channel("incident", "incident-response", 8, "Runner pool recovered; checking release queue.", {
      unread: 3,
      from: "Claude",
    }),
    channel("design", "mobile-design", 18, "Reference Telegram density: one primary action per row.", {
      from: "Yiming",
    }),
    channel("infra", "infra", 35, "Workers deploy finished in 58s.", {
      from: "Deploy Bot",
      members: {
        "agent:deploy": { kind: "agent", label: "Deploy Bot" },
      },
    }),
    channel("research", "research", 66, "Collected native mobile navigation examples.", {
      from: "Research",
    }),
    channel("customers", "customers", 140, "No new replies since the last summary.", {
      from: "Support",
    }),
    channel("thread-root", "release-0-11-25", 12, "Release blockers are down to two items.", {
      from: "Codex",
      metadata: { kind: "thread", threadRootChannelId: "launch" },
      unread: 1,
    }),
    channel("thread-ux", "ios-safe-area", 28, "Composer no longer overlaps the latest message.", {
      from: "Claude",
      metadata: { kind: "thread", threadRootChannelId: "design" },
    }),
    channel("thread-auth", "auth-migration", 75, "Better Auth migration remains isolated in WIP.", {
      from: "Codex",
      metadata: { kind: "thread", threadRootChannelId: "infra" },
    }),
  ];
  const launchHistory = [
    message("launch", 121, 24, "Yiming", "移动端列表这版先按 Telegram 的信息密度走，重点看真实消息时头像、气泡和 composer 有没有挤压。", "user"),
    message("launch", 122, 21, "Codex", "收到。我会保持浅色 native shell，把 Web 内容只放在消息区；底部 dock 贴地走现有 liquid glass，不做浮动胶囊。"),
    message("launch", 123, 17, "Claude", "列表页现在可以进入合并讨论。详情页还需要一张有真实消息的截图，主要复验头像不是破图，消息行密度不要像桌面窄屏。"),
    message("launch", 124, 12, "Codex", "我补 fixture history，避免 mock token 去请求远端 history API。这样本地截图能稳定覆盖多 sender、多行文本和底部 composer。"),
    message("launch", 125, 7, "Yiming", "可以，注意不要把临时模拟器 URL 或 fixture-only 的东西影响线上路径。", "user"),
    message("launch", 126, 2, "Codex", "Mobile list pass is ready for screenshot review. Detail view now renders a realistic message stack with local fixture data."),
  ];

  return {
    channels,
    spaces: [space],
    readCounts: {
      launch: 128,
      incident: 44,
      "thread-root": 6,
    },
    history: {
      launch: launchHistory,
    },
  };
}

/* Sidebar rows live in lists that reorder on live updates (mentions come and
   go, unread counts resort). A click needs the row to stay put between press
   and release; when an update moves it mid-click, the click is lost and the
   user has to "click twice". Selecting on pointerdown (mouse only — touch
   keeps click semantics so scroll-drags never select) beats the reorder.

   The suppress must outlive the row. Selecting on press updates `active` and
   can remount this hook before click; a per-instance ref then forgets the
   press and click navigates again, which is what wiped the first history page. */
function channelRowIdFromEventTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "";
  return target.closest("[data-channel-row-id]")?.getAttribute("data-channel-row-id") || "";
}

export function usePointerFirstSelect(select: () => void) {
  return {
    onRowPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return false;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
      const rowId = channelRowIdFromEventTarget(event.currentTarget);
      if (pointerActivationAlreadyHandled(rowId)) return true;
      event.currentTarget.classList.add("app-channel-row-active");
      select();
      rememberPointerActivation(rowId);
      return true;
    },
    onRowClick: () => {
      if (pointerActivationIsPending()) return;
      select();
    },
  };
}

export function areChannelNavItemPropsEqual(previous: ChannelNavItemProps, next: ChannelNavItemProps): boolean {
  return (
    previous.channel === next.channel &&
    previous.events === next.events &&
    previous.active === next.active &&
    previous.unreadCount === next.unreadCount &&
    previous.hasUnreadMention === next.hasUnreadMention &&
    previous.isPinnedRoot === next.isPinnedRoot &&
    previous.onSelect === next.onSelect &&
    previous.onTogglePinned === next.onTogglePinned &&
    previous.onMarkDone === next.onMarkDone &&
    previous.onOpenContextMenu === next.onOpenContextMenu
  );
}

export const productMessageAttachmentMediaClient = new ProductMessageAttachmentMediaClient();

export function scrollTimelineToBottom(
  scrollContainer: HTMLDivElement | null,
  endMarker: HTMLDivElement | null
) {
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    return;
  }
  endMarker?.scrollIntoView({ block: "end" });
}

/**
 * Watch the timeline for layout growth and report it. Rows keep growing after
 * the first paint — attachments decode, fonts swap, markdown hydrates — so a
 * bottom landing that only survives a couple of animation frames strands the
 * reader above the newest message. Returns a disposer.
 */
export function observeTimelineContentResize(
  scrollContainer: HTMLDivElement | null,
  onResize: () => void
): () => void {
  if (!scrollContainer || typeof ResizeObserver === "undefined") return () => undefined;
  // The container itself only reports viewport changes; the content wrapper
  // inside it is what grows as rows finish laying out.
  const observer = new ResizeObserver(() => onResize());
  observer.observe(scrollContainer);
  for (const child of Array.from(scrollContainer.children)) observer.observe(child);
  return () => observer.disconnect();
}

export function restoreTimelineScrollTop(scrollContainer: HTMLDivElement | null, scrollTop: number) {
  if (!scrollContainer || scrollTop <= 0) return;
  scrollContainer.scrollTop = Math.min(scrollTop, scrollContainer.scrollHeight);
}

export function channelHasAgentMembers(channel: SerializedChannel | null): boolean {
  if (!channel) return false;
  return channelMembersByPresence(channel).some(
    (member) => memberPresence(channel, member).kind === "agent"
  );
}

export function isTimelineNearBottom(scrollContainer: HTMLDivElement): boolean {
  return (
    scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight <= 48
  );
}

/* The row a `#message:` hash addresses, or null. Scrolling and verifying must
   resolve through this one function: a hash has both a raw and a
   percent-decoded candidate, and resolving twice risks scrolling one element
   and then checking the other. */
export function resolveTimelineAnchor(
  hash: string,
  scrollContainer: HTMLElement | null,
): HTMLElement | null {
  const rawAnchorId = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawAnchorId) return null;

  const anchorIds = [rawAnchorId];
  try {
    const decodedAnchorId = decodeURIComponent(rawAnchorId);
    if (decodedAnchorId !== rawAnchorId) anchorIds.push(decodedAnchorId);
  } catch {
    // Keep the raw hash when it is not percent encoded.
  }

  const element = anchorIds
    .map((anchorId) => document.getElementById(anchorId))
    .find((item): item is HTMLElement => Boolean(item));
  if (!element || (scrollContainer && !scrollContainer.contains(element))) return null;
  return element;
}

/* Whether a jump target is really on screen. Mounted is not landed: the
   virtualizer can hold a row in the DOM while the scroll position still sits
   somewhere else entirely, and `scrollIntoView` returning is not evidence that
   it arrived. That gap is exactly what a jump must not report as success. */
export function timelineRowIsOnScreen(
  element: HTMLElement | null,
  scrollContainer: HTMLElement | null,
): boolean {
  if (!element || !scrollContainer || !scrollContainer.contains(element)) return false;
  const containerBox = scrollContainer.getBoundingClientRect();
  const rowBox = element.getBoundingClientRect();
  return rowBox.bottom > containerBox.top && rowBox.top < containerBox.bottom;
}

/** Whether the whole row is inside the timeline's box, not cut off by an edge. */
export function timelineRowIsInFullView(
  element: HTMLElement | null,
  scrollContainer: HTMLElement | null,
): boolean {
  if (!element || !scrollContainer || !scrollContainer.contains(element)) return false;
  const containerBox = scrollContainer.getBoundingClientRect();
  const rowBox = element.getBoundingClientRect();
  return rowBox.top >= containerBox.top && rowBox.bottom <= containerBox.bottom;
}

/** A row a jump scrolled to has landed when its centre is in the middle
 * half of the timeline, or when the timeline cannot scroll any closer to
 * centring it (the row is near either end of what is loaded). */
export function timelineRowIsSettled(
  element: HTMLElement | null,
  scrollContainer: HTMLElement | null,
): boolean {
  if (!element || !scrollContainer) return false;
  const containerBox = scrollContainer.getBoundingClientRect();
  const rowBox = element.getBoundingClientRect();
  const offset = (rowBox.top + rowBox.bottom) / 2 - (containerBox.top + containerBox.bottom) / 2;
  if (Math.abs(offset) <= containerBox.height / 4) return true;
  const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
  return offset < 0 ? scrollContainer.scrollTop <= 0 : scrollContainer.scrollTop >= maxScroll - 1;
}

export function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}

export function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}

export function touchPoints(touches: ReactTouchEvent<HTMLDivElement>["touches"]) {
  return Array.from(touches, (touch) => ({ x: touch.clientX, y: touch.clientY }));
}

export function pointerDistance(first: { x: number; y: number }, second: { x: number; y: number }) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function pointerMidpoint(first: { x: number; y: number }, second: { x: number; y: number }) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

/** What a message row reads of its conversation: never the catalog's whole, ever-changing record. */
export type MessageRowChannel = Pick<SerializedChannel, "id" | "spaceId">;

export type MessageRowComparableProps = {
  message: TimelineItem;
  contextOnly?: boolean;
  currentUserIdentityId: string;
  channel: MessageRowChannel | null;
  token: string | null;
  mediaStore: MessageAttachmentMediaStore;
  isJoined: boolean;
  onReact: (message: TimelineItem, emoji: string) => void;
  onEdit: (message: TimelineItem, body: string) => void;
  onRecall: (message: TimelineItem) => void;
  onReply: (message: TimelineItem) => void;
  onOpenThread: (message: TimelineItem) => void;
  onMentionSender: (message: TimelineItem) => void;
  onRebornSender: (message: TimelineItem) => void;
  reborningSender: boolean;
  onQuestionnaireAnswer: (message: TimelineItem, answer: QuestionnaireAnswer) => Promise<boolean>;
  onOpenAgentTrace: (target: AgentTraceTarget) => void;
  onOpenInternalAppLink: (href: string) => boolean;
  onJumpToMessage: (messageId: string, sequence?: number) => void;
};

export function areMessageRowPropsEqual(
  previous: MessageRowComparableProps,
  next: MessageRowComparableProps
): boolean {
  return (
    previous.contextOnly === next.contextOnly &&
    previous.currentUserIdentityId === next.currentUserIdentityId &&
    previous.channel === next.channel &&
    previous.token === next.token &&
    previous.mediaStore === next.mediaStore &&
    previous.isJoined === next.isJoined &&
    previous.onReact === next.onReact &&
    previous.onEdit === next.onEdit &&
    previous.onRecall === next.onRecall &&
    previous.onReply === next.onReply &&
    previous.onOpenThread === next.onOpenThread &&
    previous.onMentionSender === next.onMentionSender &&
    previous.onRebornSender === next.onRebornSender &&
    previous.reborningSender === next.reborningSender &&
    previous.onQuestionnaireAnswer === next.onQuestionnaireAnswer &&
    previous.onOpenAgentTrace === next.onOpenAgentTrace &&
    previous.onOpenInternalAppLink === next.onOpenInternalAppLink &&
    previous.onJumpToMessage === next.onJumpToMessage &&
    timelineMessagesEqual(previous.message, next.message)
  );
}

export function clearMessageLongPress(
  timerRef: MutableRefObject<number | null>,
  startRef: MutableRefObject<{ x: number; y: number } | null>
) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  startRef.current = null;
}

export function canMentionMessageSender(message: TimelineItem): boolean {
  return !message.recalledAt && (message.senderKind === "agent" || message.senderKind === "user");
}

export function rebornBodyForMessageSender(message: TimelineItem): string | null {
  if (message.senderKind !== "agent" || message.reservedSystemAgent || message.recalledAt) {
    return null;
  }
  // Only for dead/offline instances; live controls already expose Reborn on the work dock.
  if (!message.senderInstanceStale && message.senderStatus !== "offline") {
    return null;
  }
  const mention = (message.senderMention || "").trim().replace(/^[@＠]/, "");
  if (!mention) return null;
  const separator = mention.lastIndexOf(":");
  if (separator <= 0 || separator >= mention.length - 1) return null;
  const ordinal = mention.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(ordinal)) return null;
  const name = mention.slice(0, separator).trim();
  if (!name || name.toLowerCase() === "xmatrix") return null;
  return `@${name}:${ordinal}:reborn`;
}

export function canRebornMessageSender(message: TimelineItem): boolean {
  return Boolean(rebornBodyForMessageSender(message));
}

export function isMessageActionBypassTarget(target: EventTarget): boolean {
  return target instanceof Element && Boolean(
    target.closest("a, button, audio, video, input, textarea, select, [role='button'], [contenteditable='true']")
  );
}

/**
 * The durable tail cache keeps storage locators off disk, so rows restored
 * after a restart carry no `objectKey`. It is derived from `contentHash` and
 * the loader never sends it, so only a contradicting key disqualifies a row;
 * requiring it made every restored attachment fail closed without a request.
 */
export function relayV2AttachmentMediaIdentity(attachment: ChannelAttachment): string | undefined {
  if (
    typeof attachment.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(attachment.contentHash) ||
    (attachment.objectKey !== undefined && attachment.objectKey !== `objects/${attachment.contentHash}`) ||
    !Number.isSafeInteger(attachment.version) || (attachment.version ?? 0) < 1 ||
    !Number.isSafeInteger(attachment.size) || attachment.size < 1
  ) return undefined;
  return JSON.stringify([
    attachment.id,
    attachment.version,
    attachment.contentHash,
    attachment.size,
  ]);
}

/** Preserve specialized presentation; generic files may contain playable media. */
export function presentationAttachmentKind(attachment: ChannelAttachment): ChannelAttachment["kind"] {
  if (
    attachment.kind === "image" ||
    attachment.kind === "video" ||
    attachment.kind === "markdown"
  ) {
    return attachment.kind;
  }
  return channelAttachmentKindForMimeType(attachment.mimeType, attachment.name);
}

export function attachmentSource(attachment: ChannelAttachment): string {
  return attachment.url ?? attachment.dataUrl ?? "";
}

export function attachmentDownloadHref(attachment: ChannelAttachment): string {
  const source = attachmentSource(attachment);
  if (!source || source.startsWith("data:") || source.startsWith("blob:")) return source;

  try {
    const parsed = new URL(source, "https://xmatrix.sh");
    parsed.searchParams.set("download", "1");
    if (source.startsWith("/")) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return source.includes("?") ? `${source}&download=1` : `${source}?download=1`;
  }
}

export function attachmentDownloadName(attachment: ChannelAttachment): string {
  return attachmentFilenameForMimeType(attachment.name, attachment.mimeType);
}

export function attachmentFilenameForMimeType(name: string, mimeType: string): string {
  const safeName = name.replace(/[\\/\r\n]/g, "_").slice(0, 120) || "attachment";
  const extension = attachmentExtensionForMimeType(mimeType);
  if (!extension) return safeName;

  const knownExtensionMatch = safeName.match(/\.(png|jpe?g|webp|gif|md|markdown|mdown|mkd|mp4|mov|webm|ogv|m4v)$/i);
  if (knownExtensionMatch) {
    return `${safeName.slice(0, -knownExtensionMatch[0].length)}.${extension}`;
  }
  return `${safeName}.${extension}`;
}

export function attachmentExtensionForMimeType(mimeType: string): string | null {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "text/markdown":
    case "text/x-markdown":
      return "md";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    case "video/ogg":
      return "ogv";
    case "video/x-m4v":
      return "m4v";
    default:
      return null;
  }
}

export function attachmentFetchHref(attachment: ChannelAttachment): string {
  const source = attachmentSource(attachment);
  if (!source || source.startsWith("data:")) return source;

  try {
    const parsed = new URL(source, window.location.origin);
    const apiMatch = parsed.pathname.match(
      /^\/api(?:\/xmatrix)?\/channels\/([^/]+)\/attachments\/([^/]+)$/
    );
    if (apiMatch) {
      return `${parsed.pathname.replace(/^\/api\/channels\//, "/api/xmatrix/channels/")}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return source;
  }
}

const MAX_DESKTOP_CLIPBOARD_IMAGE_BYTES = 11 * 1024 * 1024;

/** Local object-URL media keeps the Blob for clipboard (CSP blocks blob: fetch). */
type ResolvedChannelAttachment = ChannelAttachment & {
  localMediaBlob?: Blob;
};

export async function copyImageAttachmentToClipboard(
  attachment: ChannelAttachment,
  resolveMedia?: () => Promise<ChannelAttachment>,
): Promise<void> {
  // Desktop can bypass the browser clipboard sandbox and write a native image
  // directly. Preserve a PNG or JPEG source instead of converting every image
  // to PNG first: high-resolution JPEGs can inflate past Electron's bounded
  // IPC payload limit during that conversion.
  const bridge = getDesktopBridge();
  if (bridge?.writeClipboardImage) {
    const imageBlob = await loadAttachmentImageBlob(attachment, resolveMedia);
    const desktopClipboardBlob = await fitDesktopClipboardImageBlob(
      await desktopClipboardImageBlob(imageBlob),
    );
    await bridge.writeClipboardImage({
      name: attachment.name,
      mimeType: desktopClipboardBlob.type,
      size: desktopClipboardBlob.size,
      dataUrl: await blobToDataUrl(desktopClipboardBlob),
    });
    return;
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }

  // Web Clipboard API path: invoke write() immediately under the user gesture.
  // The image payload may resolve later via ClipboardItem's Promise value —
  // awaiting fetch/convert before write() loses transient activation and fails
  // silently in Chromium.
  const pngBlobPromise = loadAttachmentImagePngBlob(attachment, resolveMedia);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobPromise })]);
  } catch (writeError) {
    // Some browsers reject Promise-valued ClipboardItems. Resolve the PNG and
    // retry once while the click may still hold transient activation.
    try {
      const pngBlob = await pngBlobPromise;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    } catch {
      throw writeError;
    }
  }
}

export async function loadAttachmentImagePngBlob(
  attachment: ChannelAttachment,
  resolveMedia?: () => Promise<ChannelAttachment>,
): Promise<Blob> {
  const typed = await loadAttachmentImageBlob(attachment, resolveMedia);
  if (typed.type === "image/png") return typed;
  return convertImageBlobToPng(typed);
}

export async function loadAttachmentImageBlob(
  attachment: ChannelAttachment,
  resolveMedia?: () => Promise<ChannelAttachment>,
): Promise<Blob> {
  const ready = resolveMedia ? await resolveMedia() : attachment;
  const localMediaBlob = (ready as ResolvedChannelAttachment).localMediaBlob;
  const source = attachmentFetchHref(ready);
  if (!localMediaBlob && !source) {
    throw new Error("Image attachment is unavailable");
  }

  // CSP correctly blocks fetch(blob:…). Reuse the body that created the local
  // object URL instead of treating that URL as a network request.
  let blob: Blob;
  if (localMediaBlob) {
    blob = localMediaBlob;
  } else if (source.startsWith("data:")) {
    blob = dataUrlToBlob(source);
  } else {
    blob = await xmatrixRawResponse(source, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Image attachment request failed");
      }
      return response.blob();
    });
  }
  const typed = blob.type
    ? blob
    : new Blob([blob], { type: ready.mimeType || "application/octet-stream" });
  return typed;
}

export async function desktopClipboardImageBlob(blob: Blob): Promise<Blob> {
  // Electron's nativeImage reliably decodes these source encodings. Keeping
  // JPEG intact avoids the worst-case PNG expansion for high-resolution photos.
  if (blob.type === "image/png" || blob.type === "image/jpeg") return blob;
  return convertImageBlobToPng(blob);
}

export async function fitDesktopClipboardImageBlob(blob: Blob): Promise<Blob> {
  if (blob.size <= MAX_DESKTOP_CLIPBOARD_IMAGE_BYTES) return blob;

  // The channel attachment ceiling is larger than the desktop bridge's
  // base64-encoded IPC ceiling. Re-encode exceptional large images to a
  // bounded JPEG rather than failing the copy control after the user clicks.
  const objectUrl = URL.createObjectURL(blob);
  try {
    const compressed = await compressImageSourceToJpegBlob(
      objectUrl,
      MAX_DESKTOP_CLIPBOARD_IMAGE_BYTES,
    );
    if (!compressed || compressed.size > MAX_DESKTOP_CLIPBOARD_IMAGE_BYTES) {
      throw new Error("Image is too large to copy");
    }
    return compressed;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Keep non-exported: recovered.tsx owns the public compressImageSourceToJpegBlob export.
async function compressImageSourceToJpegBlob(src: string, targetBytes: number): Promise<Blob | null> {
  const image = await loadImageForClipboard(src);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;

  let width = image.naturalWidth || image.width;
  let height = image.naturalHeight || image.height;
  if (Math.max(width, height) > MAX_COMPRESSED_IMAGE_DIMENSION) {
    const scale = MAX_COMPRESSED_IMAGE_DIMENSION / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  let bestBlob: Blob | null = null;
  for (let quality = 0.86; quality >= 0.5; quality -= 0.12) {
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const blob = await canvasToBlobForClipboard(canvas, "image/jpeg", quality);
    if (!bestBlob || blob.size < bestBlob.size) {
      bestBlob = blob;
    }
    if (blob.size <= targetBytes) {
      return blob;
    }

    width = Math.max(1, Math.round(width * 0.82));
    height = Math.max(1, Math.round(height * 0.82));
  }

  return bestBlob;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, encoded] = dataUrl.split(",", 2);
  const mimeType = header.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  const binary = atob(encoded || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new Error("Could not read image blob as data URL"));
      }
    };
    reader.onerror = () => reject(new Error("FileReader failed to read image blob"));
    reader.readAsDataURL(blob);
  });
}

export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Image canvas is unavailable");
      }
      context.drawImage(bitmap, 0, 0);
      return await canvasToPngBlob(canvas);
    } finally {
      bitmap.close();
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image decode failed"));
      image.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image canvas is unavailable");
    }
    context.drawImage(image, 0, 0);
    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (pngBlob) resolve(pngBlob);
      else reject(new Error("Image conversion failed"));
    }, "image/png");
  });
}

export { copyTextToClipboard, busiestAgentInstance } from "./workspace-shell-formatters";

export function fixedContainingBlockRect(element: HTMLElement): DOMRect | null {
  const isActiveProperty = (value: string | undefined) => Boolean(value && value !== "none");
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.documentElement) {
    const style = window.getComputedStyle(ancestor);
    const willChange = style.willChange.split(",").map((value) => value.trim());
    const contain = style.contain.split(/\s+/);
    if (
      isActiveProperty(style.transform) ||
      isActiveProperty(style.translate) ||
      isActiveProperty(style.rotate) ||
      isActiveProperty(style.scale) ||
      isActiveProperty(style.perspective) ||
      isActiveProperty(style.filter) ||
      isActiveProperty(style.backdropFilter) ||
      willChange.some((value) =>
        ["transform", "perspective", "filter", "backdrop-filter"].includes(value)
      ) ||
      contain.some((value) => ["layout", "paint", "strict", "content"].includes(value))
    ) {
      return ancestor.getBoundingClientRect();
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

export function agentBusyTraceStaleActivity({
  agentId,
  channelId,
  events,
  instance,
  fallbackStatus,
  name,
  activity,
}: {
  agentId?: string;
  channelId?: string;
  events: ObservabilityEvent[];
  instance?: SerializedAgentInstance;
  fallbackStatus?: string;
  name: string;
  activity?: string;
}): string | undefined {
  const status = instance?.status || fallbackStatus;
  if (status !== "busy" || !instance || !agentId) return undefined;
  const target: AgentTraceTarget = {
    id: agentId,
    instanceId: instance.id,
    instanceIds: agentTraceInstanceIds(instance),
    exactInstanceIds: [instance.id],
    instanceScoped: true,
    connectedAt: instance.connectedAt,
    name,
    status,
    activity: activity || presenceStatusLabel(instance),
  };
  const latestEvent = latestAgentWorkEvent(events, target, channelId);
  if (!latestEvent || !isOlderThan(latestEvent.timestamp, AGENT_BUSY_TRACE_STALE_MS)) return undefined;
  return `Trace stale ${relativeTime(latestEvent.timestamp)}`;
}

/* busiestAgentInstance re-exported from formatters */

export { isTraceDeltaPhase } from "./workspace-shell-presence";

/** Center a toolbar within the main viewport's existing twelve-pixel gutter. */
export function centeredToolbarPosition(avatar: Element, toolbarWidth: number) {
  const avatarRect = avatar.getBoundingClientRect();
  const boundaryRect = avatar.closest(".app-main")?.getBoundingClientRect();
  const gutter = 12;
  const minLeft = (boundaryRect?.left ?? 0) + gutter;
  const boundaryRight = boundaryRect?.right ?? window.innerWidth;
  const maxLeft = Math.max(minLeft, boundaryRight - toolbarWidth - gutter);
  const preferredLeft = avatarRect.left + (avatarRect.width - toolbarWidth) / 2;
  return { left: Math.min(Math.max(preferredLeft, minLeft), maxLeft), top: avatarRect.top };
}

/**
 * A panel that grows up out of a capsule: its bottom edge is the capsule's,
 * its left edge the capsule's unless the main viewport's gutter pushes it in,
 * and it is never narrower than the capsule. Returns where the capsule sits
 * inside the panel, so the panel can start clipped to exactly that shape.
 */
export function morphPanelPosition(capsule: Element, panelWidth: number) {
  const capsuleRect = capsule.getBoundingClientRect();
  const boundaryRect = capsule.closest(".app-main")?.getBoundingClientRect();
  const gutter = 12;
  const width = Math.max(panelWidth, capsuleRect.width);
  const minLeft = (boundaryRect?.left ?? 0) + gutter;
  const maxLeft = Math.max(minLeft, (boundaryRect?.right ?? window.innerWidth) - width - gutter);
  const left = Math.min(Math.max(capsuleRect.left, minLeft), maxLeft);
  return {
    left,
    bottom: capsuleRect.bottom,
    capsuleLeft: capsuleRect.left - left,
    capsuleWidth: capsuleRect.width,
    capsuleHeight: capsuleRect.height,
  };
}

/** Follow viewport and layout changes with one queued animation frame. */
export function observeToolbarLayout(avatar: Element, toolbar: Element, layoutRoot: Element,
  position: () => void, observeMutations: boolean, shouldPosition?: () => boolean) {
  let pendingFrame: number | null = null;
  const schedule = () => {
    if (shouldPosition && !shouldPosition()) return;
    if (pendingFrame !== null) return;
    pendingFrame = window.requestAnimationFrame(() => { pendingFrame = null; position(); });
  };
  const resizeObserver = new ResizeObserver(schedule);
  for (const element of [avatar, toolbar, layoutRoot]) resizeObserver.observe(element);
  const mutationObserver = observeMutations ? new MutationObserver(schedule) : null;
  mutationObserver?.observe(layoutRoot, { attributes: true, characterData: true, childList: true, subtree: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  schedule();
  return () => {
    if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    resizeObserver.disconnect();
    mutationObserver?.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
  };
}

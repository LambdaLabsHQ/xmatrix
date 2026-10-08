"use client";

import { listenForOverlayDismissal } from "./use-overlay-dismiss";
import { MobileInlineActions } from "./mobile-inline-actions";
import { useAndroidBackDismiss } from "./use-android-back";

import {
  ChannelPresenceAvatars,
  channelHasWorkInHand,
  MobileTabDock,
} from "./workspace-shell-chrome";
import { CountPill } from "./count-pill";
import { ListCreate, type CreateAction } from "./list-create";
import { ListSectionHeading } from "./list-section-heading";

import { channelRowIndentPx, SIDEBAR_CHANNEL_HIGHLIGHT_ROW_CLASS_NAME } from "./workspace-shell-constants";

import {
  ChannelPinState,
  type ChannelPinLookup,
  areChannelNavItemPropsEqual,
  readStoredDesktopSidebarWidth,
  usePointerFirstSelect,
  useStableCallback,
} from "./workspace-shell-helpers";
import { channelEventViews } from "./workspace-shell-presence";

const NO_EVENTS: readonly ObservabilityEvent[] = [];
const NO_CHANNELS: readonly SerializedChannel[] = [];
const NO_PINNED_CHANNEL_IDS: ReadonlySet<string> = new Set();

/** Keeps the last painted rows for this Space across a refresh that has not
 *  answered yet. Rows remembered for another Space are ignored, so a switch
 *  cannot leave that list on screen. Disk rows fill the gap only until the
 *  first answer. */
function usePaintedChannelRows(
  spaceId: string | null,
  loaded: boolean,
  live: readonly SerializedChannel[],
  fallback: readonly SerializedChannel[],
) {
  const heldRef = useRef<{ spaceId: string | null; rows: readonly SerializedChannel[] } | null>(null);
  const scopedFallback = useMemo(
    () => fallback.filter((channel) => !spaceId || channel.spaceId === spaceId),
    [fallback, spaceId],
  );
  const stored = heldRef.current;
  const decision = channelRowsForPaint({
    loaded,
    live,
    held: stored && stored.spaceId === spaceId ? stored.rows : null,
    fallback: scopedFallback,
  });
  useEffect(() => {
    if (loaded) heldRef.current = { spaceId, rows: live };
  }, [loaded, live, spaceId]);
  return decision;
}
/** Rows mounted beyond the visible part of a conversation list, in pixels, so a quick scroll does not show blank space. */
const CONVERSATION_LIST_PRELOAD_PX = 600;

import {
  channelHasUnreadMention,
  channelUnreadCount,
  channelUnreadMentionJumpId,
  rankCatalogChannels,
} from "./workspace-shell-helpers-extra";

import { ChannelRowPreview } from "./channel-row-preview";
import { MentionMark } from "./mention-mark";
import { SpacePlanBadge } from "./space-plan-badge";
import { CONVERSATION_QUERY, INTAKE_QUERY, type SpaceChannelCatalog } from "./use-channel-catalog-paging";

import { AppView, MOBILE_CHANNEL_ACTION_LONG_PRESS_MS, MOBILE_CHANNEL_ACTION_MOVE_TOLERANCE_PX } from "./workspace-shell-navigation";

import {
  channelFocusedHumanMembers,
  channelOnlineAgentAvatarItems,
  spaceOwnerLabel,
  spaceRoleFor,
} from "./workspace-shell-recovered";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { createPortal } from "react-dom";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import {
  Building,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Settings2,
  Users,
  } from "lucide-react";

import { LiquidGlassFilter } from "@/components/ui/liquid-glass-filter";

import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { mobileChatTimeLabel } from "./time-display";

import { channelTitle, spaceAppPath } from "@/components/dashboard/channel-links";
import { ChannelListSkeleton, useEmptySurfaceSkeleton } from "@/components/dashboard/content-skeleton";
import { channelRowsForPaint } from "./channel-list-paint";

import { getDesktopBridge } from "@/lib/desktop/bridge";



import { cn } from "@/lib/utils";

import type {
  ObservabilityEvent,
  SerializedChannel,
  SerializedSpace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)

export type { ChannelTreeNode } from "./workspace-shell-search-model";

export type { AgentTraceTarget, ChannelNavItemProps } from "./workspace-shell-message-model";
import type { ChannelAgentAvatarItem, ChannelNavItemProps } from "./workspace-shell-message-model";

export type ChannelSidebarProps = {
  events: ObservabilityEvent[];
  spaces: SerializedSpace[];
  currentSpaceId: string | null;
  selectedChannelId: string | null;
  loading: boolean;
  error: string | null;
  view: AppView;
  readCounts: Record<string, number>;
  mentionClearedAt: Record<string, number>;
  pinState: ChannelPinState;
  readCountsBaselineReady: boolean;
  currentUserId: string;
  renamingSpaceId: string | null;
  spacesError: string | null;
  onRenameSpace: (spaceId: string, name: string) => void;
  /** Opens Team → All, where every workspace is created, deleted, or restored. */
  onManageSpaces: () => void;
  onTogglePinned: (channelId: string) => void;
  onCopyChannelLink: (channel: SerializedChannel) => Promise<void>;
  onSelectSpace: (spaceId: string) => void;
  onSelect: (channelId: string, messageId?: string) => void;
  catalogPaging: SpaceChannelCatalog;
  /** Durable catalog rows, painted until this Space's live answer arrives. */
  fallbackChannels?: readonly SerializedChannel[];
  /** The list's +, first under the Space: a new conversation. */
  create?: CreateAction | null;
};

export const ChannelSidebar = memo(function ChannelSidebar({
  events,
  spaces,
  currentSpaceId,
  selectedChannelId,
  loading,
  error,
  view,
  readCounts,
  mentionClearedAt,
  pinState,
  readCountsBaselineReady,
  currentUserId,
  renamingSpaceId,
  spacesError,
  onRenameSpace,
  onManageSpaces,
  onTogglePinned,
  onCopyChannelLink,
  onSelectSpace,
  onSelect,
  catalogPaging,
  fallbackChannels = NO_CHANNELS,
  create = null,
}: ChannelSidebarProps) {
  const [channelContextMenu, setChannelContextMenu] = useState<{
    channel: SerializedChannel;
    x: number;
    y: number;
    state: "idle" | "copied" | "failed";
  } | null>(null);
  const rootCatalogPage = catalogPaging.page(CONVERSATION_QUERY);
  useEffect(() => {
    void catalogPaging.load(CONVERSATION_QUERY);
  }, [catalogPaging]);
  // An open project's intake: what its participants started, for its
  // maintainers to find (open-project-governance.md §3).
  const maintainer = useMemo(() => {
    const role = spaces.find((space) => space.id === currentSpaceId)?.members
      ?.find((member) => member.userId === currentUserId)?.role;
    return role === "owner" || role === "admin";
  }, [currentSpaceId, currentUserId, spaces]);
  const intakeCatalogPage = catalogPaging.page(INTAKE_QUERY);
  // After the conversations themselves: intake never delays the first list.
  const conversationsLoaded = rootCatalogPage.loaded;
  useEffect(() => {
    if (maintainer && conversationsLoaded) void catalogPaging.load(INTAKE_QUERY);
  }, [catalogPaging, maintainer, conversationsLoaded]);
  const intakeChannels = useMemo(
    () => (maintainer ? intakeCatalogPage.rows.map((row) => row.channel) : []),
    [maintainer, intakeCatalogPage.rows],
  );
  const liveChannels = useMemo(
    () => rankCatalogChannels(rootCatalogPage.rows.map((row) => row.channel)
      .filter((channel) => !currentSpaceId || channel.spaceId === currentSpaceId), pinState.pinnedChannelIds),
    [rootCatalogPage.rows, currentSpaceId, pinState.pinnedChannelIds]
  );
  const paintedChannels = usePaintedChannelRows(
    currentSpaceId, rootCatalogPage.loaded, liveChannels, fallbackChannels,
  );
  const visibleChannels = paintedChannels.rows;
  // A skeleton replaces the list only while it has never had rows to paint.
  // A refresh of rows already on screen keeps them.
  const showChannelSkeleton = useEmptySurfaceSkeleton(
    !paintedChannels.confirmed && visibleChannels.length === 0
      && (loading || rootCatalogPage.loading),
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listScrollRoot, setListScrollRootElement] = useState<HTMLDivElement | null>(null);
  const setListScrollRoot = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListScrollRootElement(node);
  }, []);
  const scrollToConversationRef = useRef<((channelId: string) => void) | null>(null);
  const channelPinLookup = useMemo<ChannelPinLookup>(
    () => ({ pinnedChannelIds: new Set(pinState.pinnedChannelIds) }),
    [pinState]
  );

  useLayoutEffect(() => {
    if (view !== "messages" || !selectedChannelId) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const row = Array.from(
          listRef.current?.querySelectorAll<HTMLElement>("[data-channel-row-id]") || []
        ).find((candidate) => candidate.dataset.channelRowId === selectedChannelId);
        if (row) {
          row.scrollIntoView({ block: "nearest", inline: "nearest" });
          return;
        }
        // Conversation rows are virtualized: one off screen is not in the DOM.
        scrollToConversationRef.current?.(selectedChannelId);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [selectedChannelId, view]);

  const openChannelContextMenu = useCallback((
    channel: SerializedChannel,
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerEvent = "clientX" in event && event.clientX > 0;
    const x = pointerEvent ? event.clientX : rect.left + 24;
    const y = pointerEvent ? event.clientY : rect.top + rect.height + 4;
    setChannelContextMenu({
      channel,
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 184)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 72)),
      state: "idle",
    });
  }, []);

  const copyChannelContextMenuLink = useCallback(async () => {
    const menu = channelContextMenu;
    if (!menu) return;
    try {
      await onCopyChannelLink(menu.channel);
      setChannelContextMenu({ ...menu, state: "copied" });
      window.setTimeout(() => {
        setChannelContextMenu((current) => (
          current?.channel.id === menu.channel.id ? null : current
        ));
      }, 900);
    } catch {
      setChannelContextMenu({ ...menu, state: "failed" });
    }
  }, [channelContextMenu, onCopyChannelLink]);

  /* Rows are memoized: give them handlers that stay the same across renders
     and only their own Channel's events, so a busy Space's stream of events
     re-renders the rows it concerns instead of the whole list. */
  const selectConversationRow = useStableCallback((channel: SerializedChannel) => {
    const unreadCount = channelUnreadCount(channel, readCounts, readCountsBaselineReady);
    onSelect(channel.id, channelUnreadMentionJumpId(channel, events, mentionClearedAt, unreadCount));
  });
  const selectIntakeRow = useStableCallback((channel: SerializedChannel) => onSelect(channel.id));
  const togglePinnedRow = useStableCallback((channel: SerializedChannel) => onTogglePinned(channel.id));
  const channelEventsRef = useRef<ReadonlyMap<string, readonly ObservabilityEvent[]>>(new Map());
  const channelEvents = useMemo(() => {
    const views = channelEventViews(
      events,
      [...intakeChannels, ...visibleChannels].map((channel) => channel.id),
      channelEventsRef.current,
    );
    channelEventsRef.current = views;
    return views;
  }, [events, intakeChannels, visibleChannels]);

  useEffect(() => {
    if (!channelContextMenu) return;

    const close = () => setChannelContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [channelContextMenu]);

  return (
    <>
      <SidebarSpaceHeader
        spaces={spaces}
        currentSpaceId={currentSpaceId}
        renamingSpaceId={renamingSpaceId}
        error={spacesError}
        currentUserId={currentUserId}
        onSelectSpace={onSelectSpace}
        onRenameSpace={onRenameSpace}
        onManageSpaces={onManageSpaces}
      />
      <ListCreate action={create} />
      {/* The material sheet rides the scrolling content so rows and texture
          move together. */}
      <div
        ref={setListScrollRoot}
        className="app-material-scroll-viewport app-sidebar-pane-body min-h-0 flex-1 overflow-y-auto text-[15px]"
      >
        <div className="app-material-scroll-content min-h-full py-2 md:pt-0">
          {showChannelSkeleton && (
            <ChannelListSkeleton />
          )}
          {!rootCatalogPage.loading && (rootCatalogPage.error || error) && (
            <div className="mx-2 rounded-md bg-destructive/10 px-2 py-2 text-xs text-destructive">
              <p>{rootCatalogPage.error || error}</p>
              {rootCatalogPage.error && (
                <button type="button" onClick={() => void catalogPaging.load(
                  CONVERSATION_QUERY, { force: true },
                )}>
                  Retry
                </button>
              )}
            </div>
          )}
          {paintedChannels.confirmed && !rootCatalogPage.error && visibleChannels.length === 0 && (
            <div className="px-2 py-2 text-sm text-sidebar-foreground/60">No channels</div>
          )}
          {intakeChannels.length > 0 && (
            <div data-testid="intake-list">
              <ListSectionHeading label="Intake" count={intakeChannels.length} />
              {intakeChannels.map((channel) => (
                <ChannelNavItem
                  key={channel.id}
                  channel={channel}
                  events={channelEvents.get(channel.id) ?? NO_EVENTS}
                  active={view === "messages" && channel.id === selectedChannelId}
                  unreadCount={channelUnreadCount(channel, readCounts, readCountsBaselineReady)}
                  hasUnreadMention={false}
                  isPinnedRoot={false}
                  onSelect={selectIntakeRow}
                  onTogglePinned={togglePinnedRow}
                  onOpenContextMenu={openChannelContextMenu}
                />
              ))}
            </div>
          )}
          {/* Conversations are flat and ordered by activity, those with work in
              hand first; how the work is organized lives in Pages. A Space can
              hold a thousand: only the rows near the viewport are mounted. */}
          <VirtualChannelSections
            scrollRoot={listScrollRoot}
            scrollToChannelRef={scrollToConversationRef}
            channels={visibleChannels}
            events={events}
            pinnedChannelIds={channelPinLookup.pinnedChannelIds}
            row={(channel) => {
              const unreadCount = channelUnreadCount(channel, readCounts, readCountsBaselineReady);
              const hasUnreadMention = channelHasUnreadMention(
                channel, channelEvents.get(channel.id) ?? NO_EVENTS, mentionClearedAt, unreadCount,
              );
              return (
                <ChannelNavItem
                  channel={channel}
                  events={channelEvents.get(channel.id) ?? NO_EVENTS}
                  active={view === "messages" && channel.id === selectedChannelId}
                  unreadCount={unreadCount}
                  hasUnreadMention={hasUnreadMention}
                  isPinnedRoot={channelPinLookup.pinnedChannelIds.has(channel.id)}
                  onSelect={selectConversationRow}
                  onTogglePinned={togglePinnedRow}
                  onOpenContextMenu={openChannelContextMenu}
                />
              );
            }}
          />
          {rootCatalogPage.nextCursor && (
            <ChannelCatalogPageSentinel
              loading={rootCatalogPage.loading}
              onVisible={() => void catalogPaging.load(CONVERSATION_QUERY, { append: true })}
            />
          )}
        </div>
      </div>
      {channelContextMenu && createPortal(
        <div
          className="fixed z-[var(--z-popover)] w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          style={{ left: channelContextMenu.x, top: channelContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          aria-label={`Channel actions for ${channelTitle(channelContextMenu.channel)}`}
        >
          <button
            type="button"
            role="menuitem"
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm font-semibold hover:bg-muted",
              channelContextMenu.state === "failed" && "text-destructive"
            )}
            onClick={() => void copyChannelContextMenuLink()}
          >
            {channelContextMenu.state === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
            <span>
              {channelContextMenu.state === "copied"
                ? "Copied"
                : channelContextMenu.state === "failed"
                  ? "Copy failed"
                  : "Copy channel link"}
            </span>
          </button>
        </div>,
        document.body
      )}
    </>
  );
}, areChannelSidebarPropsEqual);

export function areChannelSidebarPropsEqual(previous: ChannelSidebarProps, next: ChannelSidebarProps): boolean {
  return (
    previous.events === next.events &&
    previous.spaces === next.spaces &&
    previous.currentSpaceId === next.currentSpaceId &&
    // The view setter closes over the held selection, so a stale one writes
    // an outdated record.
    previous.selectedChannelId === next.selectedChannelId &&
    previous.loading === next.loading &&
    previous.error === next.error &&
    previous.view === next.view &&
    previous.readCounts === next.readCounts &&
    previous.mentionClearedAt === next.mentionClearedAt &&
    previous.pinState === next.pinState &&
    previous.readCountsBaselineReady === next.readCountsBaselineReady &&
    previous.renamingSpaceId === next.renamingSpaceId &&
    previous.spacesError === next.spacesError &&
    previous.fallbackChannels === next.fallbackChannels &&
    previous.onCopyChannelLink === next.onCopyChannelLink &&
    // The + opens a draft through state setters, so only what it shows is compared.
    previous.create?.label === next.create?.label &&
    previous.create?.disabled === next.create?.disabled &&
    previous.create?.active === next.create?.active
  );
}

export function SidebarSpaceHeader({
  spaces,
  currentSpaceId,
  renamingSpaceId,
  error,
  currentUserId,
  onSelectSpace,
  onRenameSpace,
  onManageSpaces,
}: {
  spaces: SerializedSpace[];
  currentSpaceId: string | null;
  renamingSpaceId: string | null;
  error: string | null;
  currentUserId: string;
  onSelectSpace: (spaceId: string) => void;
  onRenameSpace: (spaceId: string, name: string) => void;
  onManageSpaces: () => void;
}) {
  const currentSpace = spaces.find((space) => space.id === currentSpaceId) || null;
  // Cold start knows which Space it is in before the Space record arrives. The
  // product name is not that Space's name, so wait rather than label the header
  // with it — "xMatrix" reads as a workspace the user does not have.
  const currentSpacePending = Boolean(currentSpaceId) && !currentSpace;
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renamingCurrentSpace = Boolean(currentSpace && renamingSpaceId === currentSpace.id);
  const normalizedNameCounts = spaces.reduce<Record<string, number>>((counts, space) => {
    const key = space.name.trim().toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  /* Desktop only: a Space can be opened in its own window, so two Spaces can be
     worked in side by side. The gesture is the browser's own — modifier-click or
     middle-click a row — because a nested action button inside the row's own
     button element is not valid markup. */
  const openSpaceInOwnWindow = getDesktopBridge()?.openWindow;

  useEffect(() => {
    if (!editingName && currentSpace) {
      setDraftName(currentSpace.name);
    }
  }, [currentSpace, editingName]);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function submitRename() {
    if (!currentSpace || renamingCurrentSpace) return;
    const nextName = draftName.trim();
    if (!nextName || nextName === currentSpace.name) {
      setEditingName(false);
      setDraftName(currentSpace.name);
      return;
    }
    onRenameSpace(currentSpace.id, nextName);
    setEditingName(false);
  }

  function renderSpaceRow(space: SerializedSpace) {
    const selected = space.id === currentSpaceId;
    const duplicateName = normalizedNameCounts[space.name.trim().toLowerCase()] > 1;
    const currentUserRole = spaceRoleFor(space, currentUserId);
    const ownerLabel = spaceOwnerLabel(space);
    const memberLabel = `${space.members.length} member${space.members.length === 1 ? "" : "s"}`;
    const disambiguator = duplicateName ? ` · ${spaceDisambiguatorId(space.id)}` : "";
    const subtitle = `${memberLabel} · ${currentUserRole}${disambiguator} · owner ${ownerLabel}`;

    const openInOwnWindow = () => {
      setOpen(false);
      void openSpaceInOwnWindow?.(`${spaceAppPath(space.id, spaces)}/channels`);
    };

    /* The new-window control stays a sibling of the option button: nesting a
       button is invalid markup. The hover fill is on the row, so the bar still
       runs edge to edge behind both hit targets. */
    return (
      <div key={space.id} className="app-space-switcher-row flex w-full min-w-0 items-center">
        <LiquidGlassPill
          as="button"
          type="button"
          role="option"
          aria-selected={selected}
          enabled={false}
          className={cn(
            "app-space-switcher-option flex min-h-12 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sidebar-foreground",
            selected && "app-space-switcher-option-active"
          )}
          title={`${space.name} · ${subtitle}`}
          onClick={(event: ReactMouseEvent<HTMLElement>) => {
            if (openSpaceInOwnWindow && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              openInOwnWindow();
              return;
            }
            setOpen(false);
            onSelectSpace(space.id);
          }}
          onAuxClick={(event: ReactMouseEvent<HTMLElement>) => {
            if (!openSpaceInOwnWindow || event.button !== 1) return;
            event.preventDefault();
            openInOwnWindow();
          }}
        >
          <SpaceAvatar space={space} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-black leading-5">{space.name}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] font-semibold leading-4 text-sidebar-foreground/50">
              <Users className="size-3 shrink-0" />
              <span className="truncate">{subtitle}</span>
            </span>
          </span>
          {selected && <Check className="size-4 shrink-0" />}
        </LiquidGlassPill>
        {openSpaceInOwnWindow ? (
          <button
            type="button"
            title={`Open ${space.name} in a new window`}
            aria-label={`Open ${space.name} in a new window`}
            className="app-space-switcher-open-window flex size-8 shrink-0 items-center justify-center text-sidebar-foreground"
            onClick={openInOwnWindow}
          >
            <ExternalLink className="size-4" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={menuRef} className="app-sidebar-space-header relative shrink-0 px-3 py-3">
      {editingName && currentSpace ? (
        <form
          className="app-space-switcher-edit-form flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-sidebar-foreground"
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <SpaceAvatar space={currentSpace} />
          <input
            autoFocus
            value={draftName}
            disabled={renamingCurrentSpace}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditingName(false);
                setDraftName(currentSpace.name);
              }
            }}
            className="h-8 min-w-0 flex-1 rounded border border-sidebar-border bg-sidebar-accent/60 px-2 text-lg font-black outline-none focus:border-primary"
          />
          <button
            type="submit"
            title="Save space name"
            disabled={renamingCurrentSpace || draftName.trim().length === 0}
            className="flex size-8 shrink-0 items-center justify-center rounded text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {renamingCurrentSpace ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          </button>
        </form>
      ) : (
        <div className={cn("app-space-switcher-shell group relative", open && "app-space-switcher-shell-open")}>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-busy={currentSpacePending || undefined}
            aria-label={currentSpacePending ? "Loading workspace" : undefined}
            className="app-space-switcher-trigger flex w-full min-w-0 items-center gap-3 rounded-md px-3 text-left text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => setOpen((current) => !current)}
          >
            {!currentSpace && !currentSpacePending && (
              <span className="app-space-switcher-icon flex shrink-0 items-center justify-center">
                <Building className="size-5 text-sidebar-foreground/70" />
              </span>
            )}
            {/* The chevron belongs to the name it switches, so the labels do
                not stretch to push it across the row. */}
            <span className="app-space-switcher-labels min-w-0 flex flex-initial flex-col">
              {currentSpacePending ? (
                <span
                  aria-hidden
                  className="app-space-switcher-name-pending"
                />
              ) : (
                /* The name gives up width before the mark does: a Space with
                   a long name must still show which plan it is on. */
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="app-space-switcher-name min-w-0 truncate font-black">
                    {currentSpace?.name || "xMatrix"}
                  </span>
                  {currentSpace && (
                    /* The rename control is an overlay pinned to the right of
                       this row, and it lands exactly where the mark would sit.
                       The margin is on the mark rather than on the row so that
                       a Space whose plan has not been read yet — which renders
                       no mark — gives up none of its name width for a slot
                       nothing occupies. */
                    <SpacePlanBadge
                      userId={currentUserId}
                      spaceId={currentSpace.id}
                      className="mr-7"
                    />
                  )}
                </span>
              )}
            </span>
            <ChevronDown className={cn("size-4 shrink-0 text-sidebar-foreground/60 transition-transform", open && "rotate-180")} />
          </button>
          {currentSpace && (
            <button
              type="button"
              title={`Rename ${currentSpace.name}`}
              onClick={() => {
                setOpen(false);
                setDraftName(currentSpace.name);
                setEditingName(true);
              }}
              disabled={renamingCurrentSpace}
              className="app-space-switcher-rename absolute right-10 top-1/2 z-[3] flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-sidebar-foreground/60 opacity-100 hover:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
            >
              {renamingCurrentSpace ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            </button>
          )}
          <div
            className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
            style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none" }}
            aria-hidden={!open}
          >
            <div className="min-h-0 overflow-hidden">
            <div className="app-space-switcher-menu relative z-10 mt-0 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg" role="listbox">
              {spaces.length > 0 && (
                <div className="py-1">{spaces.map((space) => renderSpaceRow(space))}</div>
              )}
              {spaces.length === 0 && (
                <div className="px-2 py-2 text-sm text-muted-foreground">No workspaces</div>
              )}
              <div className="mt-1 border-t border-border/70 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onManageSpaces();
                  }}
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-sm font-black text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  <Settings2 className="size-4 shrink-0" />
                  <span className="truncate">Manage workspaces</span>
                </button>
              </div>
            </div>
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-1 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

export { SpaceAvatar, spaceAvatarStyle, spaceDisambiguatorId } from "./workspace-shell-chrome";
import { SpaceAvatar, spaceDisambiguatorId } from "./workspace-shell-chrome";

/**
 * A conversation list's sections: the reader's pins, then those whose Agents
 * have work in hand, then the rest, each in the list's own order and each
 * conversation once. A section with no conversations is not shown.
 */
export function channelListSections(
  channels: readonly SerializedChannel[],
  events: ObservabilityEvent[],
  pinnedChannelIds: ReadonlySet<string>,
) {
  const pinned: SerializedChannel[] = [];
  const inProgress: SerializedChannel[] = [];
  const recent: SerializedChannel[] = [];
  for (const channel of channels) {
    if (pinnedChannelIds.has(channel.id)) pinned.push(channel);
    else (channelHasWorkInHand(channel, events) ? inProgress : recent).push(channel);
  }
  return [
    { label: "Pinned", count: undefined, channels: pinned },
    { label: "In progress", count: inProgress.length as number | undefined, channels: inProgress },
    { label: "Recent", count: undefined, channels: recent },
  ].filter((section) => section.channels.length > 0);
}

/** A conversation list as its sections: each one's heading, then its rows. */
function ChannelSectionRows({ channels, events, row }: {
  channels: readonly SerializedChannel[];
  events: ObservabilityEvent[];
  row: (channel: SerializedChannel) => ReactNode;
}) {
  // The cold-start paint has no pins yet; they arrive with the signed-in shell.
  return channelListSections(channels, events, NO_PINNED_CHANNEL_IDS).map((section) => (
    <Fragment key={section.label}>
      <ListSectionHeading label={section.label} count={section.count} />
      {section.channels.map(row)}
    </Fragment>
  ));
}

type ChannelSectionItem =
  | { kind: "heading"; label: string; count?: number }
  | { kind: "row"; channel: SerializedChannel };

/**
 * The same sections as ChannelSectionRows, as one virtualized list: headings
 * and rows are items, and only those near the viewport are mounted, scrolled
 * by the list's own material sheet (`scrollRoot`).
 */
function VirtualChannelSections({ scrollRoot, scrollToChannelRef, channels, events, pinnedChannelIds, row }: {
  scrollRoot: HTMLElement | null;
  /** Receives a function that brings a conversation's row into view. */
  scrollToChannelRef?: MutableRefObject<((channelId: string) => void) | null>;
  channels: readonly SerializedChannel[];
  events: ObservabilityEvent[];
  pinnedChannelIds: ReadonlySet<string>;
  row: (channel: SerializedChannel) => ReactNode;
}) {
  const items = useMemo<ChannelSectionItem[]>(() => channelListSections(channels, events, pinnedChannelIds).flatMap((section) => [
    { kind: "heading" as const, label: section.label, count: section.count },
    ...section.channels.map((channel) => ({ kind: "row" as const, channel })),
  ]), [channels, events, pinnedChannelIds]);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (!scrollToChannelRef) return;
    scrollToChannelRef.current = (channelId) => {
      const index = itemsRef.current.findIndex((item) => item.kind === "row" && item.channel.id === channelId);
      if (index >= 0) listRef.current?.scrollIntoView({ index });
    };
    return () => { scrollToChannelRef.current = null; };
  }, [scrollToChannelRef]);
  if (!scrollRoot || items.length === 0) return null;
  return (
    <Virtuoso
      ref={listRef}
      customScrollParent={scrollRoot}
      data={items}
      computeItemKey={(_index, item) => (item.kind === "row" ? item.channel.id : `section:${item.label}`)}
      increaseViewportBy={CONVERSATION_LIST_PRELOAD_PX}
      itemContent={(_index, item) => (item.kind === "row"
        ? row(item.channel)
        : <ListSectionHeading label={item.label} count={item.count} />)}
    />
  );
}

/** When the row last moved: the time the list ranks it by, not only its last message's. */
export function channelActivityAt(channel: SerializedChannel): string | undefined {
  const sentAt = channel.lastMessage?.sentAt;
  if (!sentAt) return channel.updatedAt;
  return Date.parse(channel.updatedAt) > Date.parse(sentAt) ? channel.updatedAt : sentAt;
}

/* The pre-auth paint is the same screen the authenticated shell renders, only
   inert: same root, same material planks (.app-rail/.app-sidebar/
   .app-mobile-chat-pane carry the wood textures), same row
   components. Hand-writing a second list here is what made cold start flash a
   white page with a layout nothing else in the app uses — the durable catalog
   is a data-plane cache and must not bring its own presentation with it. */
export function ColdStartChannelCatalog({
  channels,
  desktopFrameClass,
  showMobileTabDock,
}: {
  channels: SerializedChannel[];
  /** `xmatrix-desktop-macos` / `xmatrix-desktop-windows` under Electron. */
  desktopFrameClass?: string;
  /** False under the iOS shell, whose tab bar is native. */
  showMobileTabDock: boolean;
}) {
  /* The same width the authenticated sidebar restores, so the plank keeps its
     size when auth lands. Read once: this screen never resizes. */
  const [desktopSidebarWidth] = useState(readStoredDesktopSidebarWidth);
  const inert = () => {};

  return (
    <div
      className={cn(
        "xmatrix-app xmatrix-app-shell relative isolate m-0 flex h-dvh w-screen max-w-[100dvw] justify-start overflow-hidden bg-background text-foreground",
        desktopFrameClass
      )}
    >
      {desktopFrameClass === "xmatrix-desktop-windows" && (
        <div className="app-windows-caption-band" aria-hidden="true" />
      )}
      <LiquidGlassFilter />
      <div className="app-ambient pointer-events-none fixed inset-0" />
      {showMobileTabDock && <MobileTabDock activeView="messages" onChangeView={inert} />}
      {/* Rail and sidebar keep the desktop silhouette so the authenticated
          shell drops in without a layout jump. */}
      <aside
        className="app-rail hidden w-16 shrink-0 flex-col items-center bg-sidebar py-3 md:flex"
        aria-hidden
      />
      {/* The same workspace panel the signed-in shell renders. */}
      <div className="app-workspace-panel">
        <aside
          className="app-sidebar hidden w-[var(--app-desktop-sidebar-width)] flex-col bg-sidebar text-sidebar-foreground md:flex"
          style={{ "--app-desktop-sidebar-width": `${desktopSidebarWidth}px` } as CSSProperties}
        >
          <div className="app-material-scroll-viewport min-h-0 flex-1 overflow-y-auto">
            <div className="app-material-scroll-content pointer-events-none min-h-full py-2 text-[15px] md:pt-0">
              <ChannelSectionRows channels={channels} events={[]} row={(channel) => (
                <ChannelNavItem
                  key={channel.id}
                  channel={channel}
                  events={NO_EVENTS}
                  active={false}
                  isPinnedRoot={false}
                  onSelect={inert}
                  onTogglePinned={inert}
                  onOpenContextMenu={inert}
                />
              )} />
            </div>
          </div>
        </aside>
        <main className="app-main relative flex min-w-0 max-w-full flex-1 flex-col overflow-hidden bg-card/80">
          <header className="app-topbar flex h-12 shrink-0 items-center gap-2 bg-background px-3 text-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,36rem)_minmax(0,1fr)]">
            <div className="relative min-w-0 flex-1 md:hidden">
              <div className="app-mobile-title min-w-0">
                <p className="truncate text-sm font-black">Workspace</p>
              </div>
            </div>
          </header>
          <div className="app-mobile-chat-pane app-mobile-channel-list-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:hidden">
            <div className="app-material-scroll-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
              <div className="app-material-scroll-content min-h-full shrink-0">
                <div className="app-mobile-chat-list pointer-events-none">
                  <ChannelSectionRows channels={channels} events={[]} row={(channel) => (
                    <MobileChannelChatRow
                      key={channel.id}
                      displayChannel={channel}
                      events={NO_EVENTS}
                      active={false}
                      badgeCount={0}
                      hasMention={false}
                      onOpen={inert}
                      onOpenActions={inert}
                    />
                  )} />
                </div>
              </div>
            </div>
          </div>
          {/* The desktop reading slab: empty here, but present, so the message
              surface does not pop in over bare ambient when auth lands. */}
          <div className="hidden min-h-0 min-w-0 flex-1 overflow-hidden md:flex">
            <section className="app-message-surface relative flex min-w-0 flex-1 flex-col overflow-hidden" />
          </div>
        </main>
      </div>
    </div>
  );
}

/** The second line of a conversation row, shared by the phone list and the desktop list. */
function ChannelRowSecondLine({
  channel,
  events,
  humanMembers,
  avatarItems,
  hasMention,
  badgeCount,
  badgeTitle,
  trailing,
}: {
  channel: SerializedChannel;
  events: readonly ObservabilityEvent[];
  humanMembers: string[];
  avatarItems: ChannelAgentAvatarItem[];
  hasMention: boolean;
  badgeCount: number;
  badgeTitle: string;
  trailing?: ReactNode;
}) {
  return (
    <span className="app-channel-row-preview-line flex min-w-0 items-center gap-1.5">
      <span className="app-channel-row-preview app-list-row-meta min-w-0 flex-1 truncate">
        <ChannelRowPreview channel={channel} />
      </span>
      {(humanMembers.length > 0 || avatarItems.length > 0) && (
        <ChannelPresenceAvatars
          channel={channel}
          events={events}
          humanMembers={humanMembers}
          avatarItems={avatarItems}
          maxVisible={3}
        />
      )}
      {hasMention && <MentionMark />}
      {badgeCount > 0 && <CountPill count={badgeCount} title={badgeTitle} className="shrink-0" />}
      {trailing}
    </span>
  );
}

export const MobileChannelChatRow = memo(function MobileChannelChatRow({
  displayChannel,
  events,
  active,
  badgeCount,
  hasMention,
  onOpen,
  onOpenActions,
}: {
  displayChannel: SerializedChannel;
  /** This Channel's events only (`channelEventViews`), so other Channels' events do not re-render the row. */
  events: readonly ObservabilityEvent[];
  active: boolean;
  badgeCount: number;
  hasMention: boolean;
  /* The row passes its own Channel, so one stable handler serves every row. */
  onOpen: (channel: SerializedChannel) => void;
  onOpenActions: (channel: SerializedChannel) => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPointerRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const selectionSuppressionCleanupRef = useRef<(() => void) | null>(null);
  const suppressNativeSelectionRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const timeLabel = mobileChatTimeLabel(channelActivityAt(displayChannel));
  const focusedHumanMembers = channelFocusedHumanMembers(displayChannel);
  const agentAvatarItems = channelOnlineAgentAvatarItems(displayChannel);
  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPointerRef.current = null;
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const stopNativeSelectionSuppression = useCallback(() => {
    selectionSuppressionCleanupRef.current?.();
    selectionSuppressionCleanupRef.current = null;
    suppressNativeSelectionRef.current = false;
    document.getSelection()?.removeAllRanges();
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const preventNativeSelection = (event: Event) => {
      event.preventDefault();
      document.getSelection()?.removeAllRanges();
    };
    row.addEventListener("selectstart", preventNativeSelection, true);
    return () => {
      row.removeEventListener("selectstart", preventNativeSelection, true);
      stopNativeSelectionSuppression();
    };
  }, [stopNativeSelectionSuppression]);

  /* A tap opens the channel from pointerup, not from click: these rows sit in a
     list that re-sorts on live updates, and a row that moves between press and
     release loses its click (the same "click twice" failure usePointerFirstSelect
     documents for the desktop sidebar, which deliberately excludes touch). The
     listener is on window so a release that lands on whatever row slid under the
     finger still resolves to the row that was pressed. */
  const openFromPointerUp = (event: PointerEvent) => {
    const pointer = longPressPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    clearLongPress();
    if (
      Math.abs(event.clientX - pointer.x) > MOBILE_CHANNEL_ACTION_MOVE_TOLERANCE_PX ||
      Math.abs(event.clientY - pointer.y) > MOBILE_CHANNEL_ACTION_MOVE_TOLERANCE_PX
    ) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest?.("[data-mobile-channel-action='true']")) return;
    if (suppressNextClickRef.current) return;
    // The click that follows this release must not open the channel twice.
    suppressNextClickRef.current = true;
    onOpen(displayChannel);
  };

  const startLongPress = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    clearLongPress();
    stopNativeSelectionSuppression();
    // Suppression is per gesture: a stale flag would eat the next real tap.
    suppressNextClickRef.current = false;
    suppressNativeSelectionRef.current = true;
    document.getSelection()?.removeAllRanges();
    const clearSelectionWhilePressed = () => {
      if (!suppressNativeSelectionRef.current) return;
      document.getSelection()?.removeAllRanges();
    };
    const finishPointerGesture = (pointerEvent: PointerEvent) => {
      if (pointerEvent.type === "pointerup") openFromPointerUp(pointerEvent);
      else clearLongPress();
      stopNativeSelectionSuppression();
    };
    document.addEventListener("selectionchange", clearSelectionWhilePressed);
    window.addEventListener("pointerup", finishPointerGesture, true);
    window.addEventListener("pointercancel", finishPointerGesture, true);
    selectionSuppressionCleanupRef.current = () => {
      document.removeEventListener("selectionchange", clearSelectionWhilePressed);
      window.removeEventListener("pointerup", finishPointerGesture, true);
      window.removeEventListener("pointercancel", finishPointerGesture, true);
    };
    longPressPointerRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    longPressTimerRef.current = window.setTimeout(() => {
      if (!longPressPointerRef.current) return;
      suppressNextClickRef.current = true;
      document.getSelection()?.removeAllRanges();
      onOpenActions(displayChannel);
      clearLongPress();
    }, MOBILE_CHANNEL_ACTION_LONG_PRESS_MS);
  };

  const openActions = () => {
    document.getSelection()?.removeAllRanges();
    onOpenActions(displayChannel);
  };

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      className={cn(
        "app-mobile-chat-row app-channel-row app-channel-chat-row app-list-row flex w-full text-left",
        active && "app-mobile-chat-row-active app-channel-row-active"
      )}
      style={{ paddingLeft: `${channelRowIndentPx(0)}px` }}
      data-mobile-channel-row-id={displayChannel.id}
      data-unread-mention={hasMention ? "true" : undefined}
      aria-label={`Open #${channelTitle(displayChannel)}`}
      onClick={(event) => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onOpen(displayChannel);
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-mobile-channel-action='true']")) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          openActions();
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(displayChannel);
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-mobile-channel-action='true']")) return;
        startLongPress(event);
      }}
      onPointerMove={(event) => {
        const pointer = longPressPointerRef.current;
        if (!pointer || pointer.pointerId !== event.pointerId) return;
        if (
          Math.abs(event.clientX - pointer.x) > MOBILE_CHANNEL_ACTION_MOVE_TOLERANCE_PX ||
          Math.abs(event.clientY - pointer.y) > MOBILE_CHANNEL_ACTION_MOVE_TOLERANCE_PX
        ) {
          stopNativeSelectionSuppression();
          clearLongPress();
        }
      }}
      onPointerUp={() => {
        stopNativeSelectionSuppression();
        clearLongPress();
      }}
      onPointerCancel={() => {
        stopNativeSelectionSuppression();
        clearLongPress();
      }}
      onDragStart={(event) => event.preventDefault()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openActions();
      }}
    >
      {/* The desktop's conversation row: the name and when on the first
          line, who said what, who is here and what is unread on the second. */}
      <span className="app-channel-row-title-line flex min-w-0 items-baseline gap-2">
        <span className="app-channel-row-title flex min-w-0 flex-1 items-baseline">
          <span className="app-channel-row-hash shrink-0" aria-hidden="true">#</span>
          <span className="app-mobile-chat-title app-channel-row-name app-list-row-title min-w-0 truncate">
            {channelTitle(displayChannel)}
          </span>
        </span>
        <span className="app-channel-row-time shrink-0 self-center">{timeLabel}</span>
      </span>
      <ChannelRowSecondLine
        channel={displayChannel}
        events={events}
        humanMembers={focusedHumanMembers}
        avatarItems={agentAvatarItems}
        hasMention={hasMention}
        badgeCount={badgeCount}
        badgeTitle={hasMention ? "Unread mention" : "Unread messages"}
      />
    </div>
  );
});

/* A long press on a channel row opens its actions as a row of options right
   under it (a tap on the row still opens the channel). Any touch elsewhere,
   Escape, or system Back closes them. */
export function MobileChannelInlineActions({
  channel,
  pinned,
  onClose,
  onTogglePinned,
  onCopyChannelLink,
}: {
  channel: SerializedChannel;
  pinned: boolean;
  onClose: () => void;
  onTogglePinned: () => void;
  onCopyChannelLink: () => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useAndroidBackDismiss(true, onClose);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) onClose();
    };
    return listenForOverlayDismissal(closeOnOutsidePointer, onClose);
  }, [onClose]);

  const copyLink = async () => {
    try {
      await onCopyChannelLink();
      setCopyState("copied");
      window.setTimeout(onClose, 650);
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div ref={ref}>
      <MobileInlineActions
        label={`Channel actions for ${channelTitle(channel)}`}
        className="app-mobile-channel-inline-actions"
        actions={[
          {
            key: "pin",
            icon: pinned ? PinOff : Pin,
            label: pinned ? "Unpin channel" : "Pin channel",
            onSelect: onTogglePinned,
          },
          {
            key: "copy-link",
            icon: copyState === "copied" ? Check : Copy,
            label: copyState === "copied"
              ? "Link copied"
              : copyState === "failed"
                ? "Copy failed — try again"
                : "Copy channel link",
            destructive: copyState === "failed",
            onSelect: () => void copyLink(),
          },
        ]}
      />
    </div>
  );
}

export function MobileChannelChatList({
  currentSpaceId,
  catalogPaging,
  fallbackChannels = NO_CHANNELS,
  pinState,
  selectedChannelId,
  pendingChannelId = null,
  readCounts,
  mentionClearedAt,
  readCountsBaselineReady,
  events,
  canCreateChannel,
  onTogglePinned,
  onCopyChannelLink,
  onSelect,
}: {
  currentSpaceId: string | null;
  catalogPaging: SpaceChannelCatalog;
  /** Durable catalog rows, painted until this Space's live answer arrives. */
  fallbackChannels?: readonly SerializedChannel[];
  pinState: ChannelPinState;
  selectedChannelId: string | null;
  /** Tapped while the list was still the cold-start catalog; opens once the
      authenticated channel lands, and stays highlighted until it does. */
  pendingChannelId?: string | null;
  readCounts: Record<string, number>;
  mentionClearedAt: Record<string, number>;
  readCountsBaselineReady: boolean;
  events: ObservabilityEvent[];
  /** False until the signed-in person and their Space have loaded. */
  canCreateChannel: boolean;
  onTogglePinned: (channelId: string) => void;
  onCopyChannelLink: (channel: SerializedChannel) => Promise<void>;
  onSelect: (channelId: string, messageId?: string) => void;
}) {
  const [actionChannelId, setActionChannelId] = useState<string | null>(null);
  const page = catalogPaging.page(CONVERSATION_QUERY);
  useEffect(() => {
    void catalogPaging.load(CONVERSATION_QUERY);
  }, [catalogPaging]);
  const liveConversations = useMemo(
    () => rankCatalogChannels(page.rows.map((row) => row.channel)
      .filter((channel) => !currentSpaceId || channel.spaceId === currentSpaceId), pinState.pinnedChannelIds),
    [currentSpaceId, page.rows, pinState.pinnedChannelIds]
  );
  const paintedConversations = usePaintedChannelRows(
    currentSpaceId, page.loaded, liveConversations, fallbackChannels,
  );
  const conversations = paintedConversations.rows;
  const showChannelSkeleton = useEmptySurfaceSkeleton(
    !paintedConversations.confirmed && conversations.length === 0 && page.loading,
  );
  const closeChannelActions = useCallback(() => setActionChannelId(null), []);
  const openConversation = useStableCallback((channel: SerializedChannel) => {
    const unreadCount = channelUnreadCount(channel, readCounts, readCountsBaselineReady);
    onSelect(channel.id, channelUnreadMentionJumpId(channel, events, mentionClearedAt, unreadCount));
  });
  const openConversationActions = useCallback((channel: SerializedChannel) => setActionChannelId(channel.id), []);
  const channelEventsRef = useRef<ReadonlyMap<string, readonly ObservabilityEvent[]>>(new Map());
  const channelEvents = useMemo(() => {
    const views = channelEventViews(events, conversations.map((channel) => channel.id), channelEventsRef.current);
    channelEventsRef.current = views;
    return views;
  }, [conversations, events]);

  const [listScrollRoot, setListScrollRoot] = useState<HTMLDivElement | null>(null);
  const pinnedChannelIds = useMemo(() => new Set(pinState.pinnedChannelIds), [pinState]);

  return (
    <>
      <div ref={setListScrollRoot} className="app-material-scroll-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="app-material-scroll-content min-h-full shrink-0">
          <div className="app-mobile-chat-list">
            {showChannelSkeleton && (
              <ChannelListSkeleton />
            )}
            {page.error && (
              <div className="app-mobile-list-empty px-3 py-6 text-center text-[13px]">
                <p>{page.error}</p>
                <button type="button" onClick={() => void catalogPaging.load(CONVERSATION_QUERY, { force: true })}>
                  Retry
                </button>
              </div>
            )}
            {paintedConversations.confirmed && !page.error && conversations.length === 0 && (
              <div className="app-mobile-list-empty app-mobile-channel-empty px-3 py-6 text-center text-[13px]">
                {/* The + beside the dock starts one; the empty list only says so. */}
                <p>No conversations yet</p>
                {canCreateChannel && <span>Tap + to start one.</span>}
              </div>
            )}
            {/* The list meets the plank with its first section's name, never a
                bare row; only the rows near the viewport are mounted. */}
            <VirtualChannelSections
              scrollRoot={listScrollRoot}
              channels={conversations}
              events={events}
              pinnedChannelIds={pinnedChannelIds}
              row={(channel) => {
                const unreadCount = channelUnreadCount(channel, readCounts, readCountsBaselineReady);
                const hasMention = channelHasUnreadMention(
                  channel, channelEvents.get(channel.id) ?? NO_EVENTS, mentionClearedAt, unreadCount,
                );
                return (
                  <div className="app-mobile-channel-flat-node">
                    <MobileChannelChatRow
                      displayChannel={channel}
                      events={channelEvents.get(channel.id) ?? NO_EVENTS}
                      active={channel.id === selectedChannelId
                        || channel.id === actionChannelId
                        || channel.id === pendingChannelId}
                      badgeCount={Math.max(unreadCount, channel.attention?.unreadAttentionCount || 0)}
                      hasMention={hasMention}
                      onOpen={openConversation}
                      onOpenActions={openConversationActions}
                    />
                    {channel.id === actionChannelId && (
                      <MobileChannelInlineActions
                        channel={channel}
                        pinned={pinState.pinnedChannelIds.includes(channel.id)}
                        onClose={closeChannelActions}
                        onTogglePinned={() => {
                          onTogglePinned(channel.id);
                          setActionChannelId(null);
                        }}
                        onCopyChannelLink={() => onCopyChannelLink(channel)}
                      />
                    )}
                  </div>
                );
              }}
            />
            {page.nextCursor && (
              <ChannelCatalogPageSentinel
                loading={page.loading}
                onVisible={() => void catalogPaging.load(CONVERSATION_QUERY, { append: true })}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function ChannelCatalogPageSentinel({
  loading,
  onVisible,
}: {
  loading: boolean;
  onVisible: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // A page-1 refresh also sets loading. A channel-shaped skeleton here reads
  // as a new conversation flickering in. Wait, then a single quiet line.
  const showSkeleton = useEmptySurfaceSkeleton(loading);
  useEffect(() => {
    const element = ref.current;
    if (!element || loading || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible();
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, onVisible]);
  return (
    <div ref={ref}>
      {showSkeleton ? (
        <div className="flex h-9 items-center px-5" role="status" aria-label="Loading more channels">
          <span className="app-content-skeleton-line" data-width="medium" aria-hidden="true" />
        </div>
      ) : (
        <div className="flex h-9 items-center justify-center text-xs text-sidebar-foreground/45">More</div>
      )}
    </div>
  );
}

/* ChannelNavItemProps owned by message-model */

export const ChannelNavItem = memo(function ChannelNavItem({
  channel,
  events,
  active,
  unreadCount = 0,
  hasUnreadMention = false,
  isPinnedRoot,
  onSelect,
  onTogglePinned,
  onOpenContextMenu,
}: ChannelNavItemProps) {
  const { onRowPointerDown, onRowClick } = usePointerFirstSelect(() => onSelect(channel));
  const focusedHumanMembers = channelFocusedHumanMembers(channel);
  const agentAvatarItems = channelOnlineAgentAvatarItems(channel);
  const pinActionLabel = isPinnedRoot
    ? `Unpin #${channelTitle(channel)}`
    : `Pin #${channelTitle(channel)}`;

  return (
    <LiquidGlassPill
      as="div"
      enabled={active}
      fill={active}
      data-channel-row-id={channel.id}
      data-unread-mention={hasUnreadMention ? "true" : undefined}
      className={cn(
        SIDEBAR_CHANNEL_HIGHLIGHT_ROW_CLASS_NAME,
        "app-channel-chat-row app-list-row",
        active && "app-channel-row-active text-sidebar-accent-foreground",
      )}
      style={{ paddingLeft: `${channelRowIndentPx(0)}px` }}
      onClick={onRowClick}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-channel-row-action='true']")) return;
        onRowPointerDown(event);
      }}
      onContextMenu={(event) => onOpenContextMenu(channel, event)}
    >
      {/* A chat row: who said what last reads under the title, the way a
          conversation list does, so the list answers "where is something
          happening" without opening each channel. */}
      <span className="app-channel-row-title-line flex min-w-0 items-baseline gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRowClick();
          }}
          className="app-channel-row-title flex min-w-0 flex-1 items-baseline text-left"
        >
          <span className="app-channel-row-hash shrink-0" aria-hidden="true">#</span>
          <span className="app-channel-row-name app-list-row-title min-w-0 truncate">{channelTitle(channel)}</span>
        </button>
        <span className="app-channel-row-time shrink-0 self-center">{mobileChatTimeLabel(channelActivityAt(channel))}</span>
      </span>
      <ChannelRowSecondLine
        channel={channel}
        events={events}
        humanMembers={focusedHumanMembers}
        avatarItems={agentAvatarItems}
        hasMention={hasUnreadMention}
        badgeCount={unreadCount}
        badgeTitle={
          hasUnreadMention
            ? `Unread mention in #${channelTitle(channel)}`
            : `Unread messages in #${channelTitle(channel)}`
        }
        trailing={<button
          type="button"
          data-channel-row-action="true"
          aria-label={pinActionLabel}
          title={pinActionLabel}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePinned(channel);
          }}
          className={cn(
            "group/pin-toggle relative flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/55 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            isPinnedRoot
              ? "text-sidebar-accent-foreground"
              : "[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/channel-row:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/channel-row:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/channel-row:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/channel-row:opacity-100"
          )}
        >
          <Pin
            className={cn(
              "size-3.5 transition-opacity",
              isPinnedRoot && "group-focus-visible/pin-toggle:opacity-0 group-hover/pin-toggle:opacity-0"
            )}
          />
          {isPinnedRoot && (
            <PinOff className="absolute size-3.5 opacity-0 transition-opacity group-focus-visible/pin-toggle:opacity-100 group-hover/pin-toggle:opacity-100" />
          )}
        </button>}
      />
    </LiquidGlassPill>
  );
}, areChannelNavItemPropsEqual);

"use client";

import { normalizeChannelSearchText } from "./workspace-shell-search-model";
import type { LiquidGlassMaterial } from "@/components/ui/liquid-glass-material";
import { LiquidGlassPill, WoodPanel } from "@/components/ui/material-surfaces";
import type { CreateAction } from "./list-create";
import { useGlobalSearchClearance } from "./global-search-clearance";

import {
  agentInstanceDisplayName,
  agentInstanceDisplayStatus,
} from "./workspace-composer-dialogs";

import {
  COUNT_CHIP_MATERIAL_CLASS,
} from "./workspace-shell-constants";


import {
  ChannelCreateMode,
  copyTextToClipboard,
} from "./workspace-shell-helpers";


import {
  AppView,
  DOCK_TAB_VIEWS,
  MORE_TAB_VIEWS,
  viewLabels,
} from "./workspace-shell-navigation";

import {
  avatarInitials,
  channelOnlineAgentAvatarItems,
  formatMember,
  initialsFor,
  memberPresence,
  memberPresenceSummary,
  presenceAvatarUrl,
  spaceRoleFor,
  visibleHumanChannelMembers,
} from "./workspace-shell-recovered";
import type { SpaceChannelCatalog } from "./use-channel-catalog-paging";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { createPortal } from "react-dom";

import { listenForOverlayDismissal } from "./use-overlay-dismiss";
import { useAndroidBackDismiss } from "./use-android-back";

import {
  ArrowUp,
  BookOpen,
  Building,
  BookText,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleArrowUp,
  CircleHelp,
  Clock,
  Bot,
  HardDrive,
  Hash,
  MessagesSquare,
  Lock,
  Loader2,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  MoveRight,
  Pencil,
  FileText,
  PlugZap,
  Plus,
  Settings,
  Share,
  Share2,
  Shield,
  Users,
  X,
} from "lucide-react";
import { SearchGlyph } from "@/components/ui/search-glyph";
import { useConversationPages } from "@/components/pages/conversation-page-cards";

import {
  CenteredDialogShell,
  DialogButton,
  DialogInset,
  DialogPanelFooter,
  DialogPanelHeader,
} from "@/components/dashboard/centered-dialog-shell";

import { Sheet, SheetContent } from "@/components/ui/sheet";

import { IdentityAvatar } from "@/components/dashboard/identity-avatar";


import {
  absoluteChannelUrl,
  channelTitle,
} from "@/components/dashboard/channel-links";

import {
  type DesktopUpdateStatus,
} from "@/lib/desktop/bridge";

import { cn } from "@/lib/utils";
import { GlassSelect } from "@/components/ui/glass-select";

import type {
  ChannelMemberPresence,
  ObservabilityEvent,
  SerializedAgentInstance,
  HumanProfile,
  SerializedChannel,
  SerializedSpace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)

export type { WorkspaceSearchResult } from "./workspace-shell-search-model";

export function WorkspaceRail({
  activeView,
  profile,
  platformAdmin,
  onChangeView,
  onOpenProfile,
  onLogout,
  onReportIssue,
  pendingJoinRequestCount,
  statusLive,
  updateControl,
}: {
  activeView: AppView;
  profile: HumanProfile;
  /** Hub-reported operator capability; the admin route re-checks it. */
  platformAdmin?: boolean;
  onChangeView: (view: AppView) => void;
  /** Opens the viewer's own Profile view; the rail avatar's only job. */
  onOpenProfile: () => void;
  onLogout: () => void;
  /** Opens the GitHub issue form for a report. */
  onReportIssue?: () => void;
  /** People waiting on this admin in the current Space. */
  pendingJoinRequestCount?: number;
  /** An Agent in the Space is working now: the Status pulse runs. */
  statusLive?: boolean;
  /** The desktop app's update bead, above the bottom actions. */
  updateControl?: React.ReactNode;
}) {
  const conversations = activeView === "messages";
  return (
    <aside
      className="app-rail relative hidden w-16 shrink-0 flex-col items-center bg-sidebar py-3 text-foreground md:flex"
    >
      {/* Slack's avatar is a destination, not a menu: it takes you to your
          profile. Sign out already has its own rail button at the bottom. */}
      <button
        type="button"
        title="Your profile"
        aria-label="Your profile"
        aria-current={activeView === "profile" ? "page" : undefined}
        onClick={onOpenProfile}
        className="flex size-11 items-center justify-center rounded-full"
      >
        <IdentityAvatar
          kind="human"
          label={profile.displayName}
          imageUrl={profile.avatarUrl}
          initials={profile.displayName.slice(0, 2)}
          size="md"
          showKindBadge={false}
          className="app-rail-user-avatar"
        />
      </button>
      <div className="mt-5 flex flex-1 flex-col items-center gap-2">
        <RailButton active={activeView === "pages"} icon={BookOpen} label="Pages" onClick={() => onChangeView("pages")} />
        <RailButton
          active={conversations}
          icon={MessagesSquare}
          label="Channels"
          onClick={() => onChangeView("messages")}
        />
        <RailButton active={activeView === "status"} icon={statusLive ? StatusPulseIconLive : StatusPulseIcon} label="Status"
          onClick={() => onChangeView("status")} />
        <RailButton active={activeView === "machines" || activeView === "local"} icon={HardDrive} label="Machines" onClick={() => onChangeView("machines")} />
        <RailButton active={activeView === "automation"} icon={Clock} label="Schedules" onClick={() => onChangeView("automation")} />
        <RailButton active={activeView === "agents"} icon={Bot} label="Agents" onClick={() => onChangeView("agents")} />
        <RailButton active={activeView === "apps"} icon={PlugZap} label="App" onClick={() => onChangeView("apps")} />
        <RailButton
          active={activeView === "team"}
          icon={Users}
          label="Team"
          badge={pendingJoinRequestCount}
          onClick={() => onChangeView("team")}
        />
        <RailButton active={activeView === "settings"} icon={Settings} label="Settings" onClick={() => onChangeView("settings")} />
        {platformAdmin && (
          <RailButton active={activeView === "admin"} icon={Shield} label="Platform admin" onClick={() => onChangeView("admin")} />
        )}
      </div>
      <div className="flex flex-col items-center gap-2">
        {updateControl}
        <HelpRailMenu onReportIssue={onReportIssue} />
        <RailButton icon={LogOut} label="Sign out" onClick={onLogout} />
      </div>
    </aside>
  );
}

/** Help is one "?" on the rail: the docs and issue reports live in its menu,
    so neither needs an icon of its own that could pass for something else. */
function HelpRailMenu({ onReportIssue }: { onReportIssue?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPos({ left: rect.right + 8, bottom: Math.max(12, window.innerHeight - rect.bottom) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return listenForOverlayDismissal((event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (anchorRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    }, () => setOpen(false));
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const itemClassName = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-popover-foreground hover:bg-muted";

  return (
    <span ref={anchorRef} className="flex">
      <RailButton active={open} icon={CircleHelp} label="Help" onClick={() => setOpen((next) => !next)} />
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Help"
          className="xmatrix-app app-rail-help-menu fixed z-[var(--z-popover)] w-52 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
          style={{ left: pos.left, bottom: pos.bottom }}
        >
          <button type="button" role="menuitem" className={itemClassName}
            onClick={() => choose(() => window.open("/docs", "_blank"))}>
            <BookText className="size-4 shrink-0 text-muted-foreground" />
            <span>Documentation</span>
          </button>
          {onReportIssue && (
            <button type="button" role="menuitem" className={itemClassName} onClick={() => choose(onReportIssue)}>
              <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
              <span>Report an issue</span>
            </button>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}

/** The phone's +, a wood plank just above the web or native tab bar, on a
    dock tab's own screen only. */
export function CreateFab({ action }: { action: CreateAction | null }) {
  if (!action) return null;
  return (
    <WoodPanel
      as="button"
      type="button"
      title={action.label}
      aria-label={action.label}
      disabled={action.disabled}
      onClick={action.onCreate}
      className="app-mobile-create-fab inline-flex items-center justify-center disabled:opacity-40 md:hidden"
    >
      <Plus className="size-6" />
    </WoodPanel>
  );
}

export function MobileTabDock({
  activeView,
  hidden,
  statusLive,
  onChangeView,
}: {
  activeView: AppView;
  hidden?: boolean;
  /** An Agent in the Space is working now: the Status pulse runs. */
  statusLive?: boolean;
  onChangeView: (view: AppView) => void;
}) {
  if (hidden) return null;
  const items: Array<{ view: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { view: "pages", label: "Pages", icon: BookOpen },
    { view: "messages", label: "Channels", icon: MessagesSquare },
    { view: "status", label: "Status", icon: statusLive ? StatusPulseIconLive : StatusPulseIcon },
    { view: "more", label: "More", icon: MoreHorizontal },
  ];

  return (
    // The dock decides how many tabs exist; the stylesheet only reads the
    // count. Hard-coding the column count in CSS meant adding a tab silently
    // squeezed the last one out of its track.
    <LiquidGlassPill
      as="nav"
      fill
      className="app-mobile-tab-dock app-material-liquid-pill inline-flex md:hidden"
      style={{ "--app-mobile-tab-count": items.length } as CSSProperties}
      aria-label="Primary"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.view === "more"
          ? MORE_TAB_VIEWS.includes(activeView)
          : activeView === item.view;
        return (
          <button
            key={item.view}
            type="button"
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "app-mobile-tab-button",
              active && "app-channel-row app-channel-row-active app-mobile-tab-button-active"
            )}
            onClick={() => onChangeView(item.view)}
          >
            <Icon className="size-5" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </LiquidGlassPill>
  );
}

/**
 * The global search entry for destinations without a conversation header: the
 * same bare magnifier a conversation header ends with, at the window's top right.
 */
export function GlobalSearchBar({ searching, onOpenSearch }: {
  searching: boolean;
  onOpenSearch: () => void;
}) {
  const shortcut = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘F" : "Ctrl+F";
  const iconRef = useRef<HTMLButtonElement | null>(null);
  useGlobalSearchClearance(iconRef);
  return (
    <div className="app-global-bar hidden md:flex">
      <button
        ref={iconRef}
        type="button"
        title={`Search (${shortcut})`}
        aria-label="Search"
        onClick={onOpenSearch}
        data-search-anchor=""
        className={cn(
          "app-global-search flex size-8 items-center justify-center text-muted-foreground hover:text-foreground",
          searching && "invisible"
        )}
      >
        <SearchGlyph className="size-4" />
      </button>
    </div>
  );
}

/** Lucide's Activity line, drawn by hand so its trace can run. */
const STATUS_PULSE_PATH = "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2";

/**
 * Status: a pulse line. While an Agent in the Space works, a break runs along
 * it left to right, the way a monitor redraws its trace; at rest the line is
 * whole.
 */
export function StatusPulseIcon({ className, live = false }: { className?: string; live?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      strokeLinejoin="round" className={cn("app-status-pulse", className)} data-live={live || undefined}
      aria-hidden="true">
      <path d={STATUS_PULSE_PATH} pathLength={1} />
    </svg>
  );
}

function StatusPulseIconLive({ className }: { className?: string }) {
  return <StatusPulseIcon className={className} live />;
}

export function RailButton({
  active,
  icon: Icon,
  label,
  badge,
  disabled,
  className,
  onClick,
}: {
  active?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Count of things waiting here. Omitted or zero shows nothing. */
  badge?: number;
  disabled?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  /* The selected destination is the composer buttons' glass pill, lens included.
     The badge hangs off the button's corner, so it is the button's sibling:
     inside the glass it is clipped by the pill's overflow. */
  return (
    <span className="relative flex size-10 shrink-0 self-center">
      <LiquidGlassPill
        as="button"
        enabled={active === true}
        title={badge ? `${label} (${badge})` : label}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "relative flex size-10 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground disabled:cursor-default",
          active && "text-foreground hover:text-foreground",
          className
        )}
      >
        <Icon className="size-5" />
      </LiquidGlassPill>
      {/* Deliberately NOT the shared count chip: this is the rail's alert badge
          for pending join requests, and its red is the alert, not decoration.
          Unifying it would be a separate call. */}
      {badge ? (
        <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-black leading-4 text-destructive-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </span>
  );
}

export function TopWorkspaceBar({
  page = null,
  onClosePage,
  composing = false,
  onCloseComposing,
  channel,
  spaces,
  currentSpaceId,
  view,
  onBack,
  onOpenMore,
  onOpenSearch,
  onShareChannel,
  onOpenChannelDetails,
  onSelectSpace,
  onClosePageConversation,
}: {
  /** A page open on a phone: the bar is its back bar, like a conversation's. */
  page?: { title: string } | null;
  onClosePage?: () => void;
  /** A conversation opened from a page on a phone is pushed over the page; Back returns to it. */
  onClosePageConversation?: () => void;
  /** A new conversation on a phone: a pushed screen with its own back bar. */
  composing?: boolean;
  onCloseComposing?: () => void;
  channel: SerializedChannel | null;
  spaces: SerializedSpace[];
  currentSpaceId: string | null;
  view: AppView;
  onBack: () => void;
  onOpenMore: () => void;
  onOpenSearch?: () => void;
  /* Mobile only: ChannelHeader (app-panel-header) is display:none under max-md. */
  onShareChannel?: () => void | Promise<void>;
  onOpenChannelDetails?: () => void;
  onSelectSpace: (spaceId: string) => void;
}) {
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const conversationOverPage = view === "pages" && Boolean(channel) && Boolean(onClosePageConversation);
  const pageOpen = view === "pages" && Boolean(page) && !conversationOverPage;
  const composingOpen = view === "messages" && composing;
  const conversationOpen = (view === "messages" || conversationOverPage) && Boolean(channel);
  const showBack = conversationOpen || pageOpen || composingOpen;
  const showMoreBack = view !== "messages" && view !== "more" && MORE_TAB_VIEWS.includes(view);
  const currentSpace = currentSpaceId
    ? spaces.find((space) => space.id === currentSpaceId) || null
    : null;
  const spaceName = currentSpace?.name || "Workspace";
  // A dock tab's own screen is named by the dock, which is right there, so the
  // bar names only the Space. A screen pushed from More still needs the bar
  // as its title (a paper destination hides its own heading under md).
  const tabRoot = !showBack && DOCK_TAB_VIEWS.includes(view);
  const mobileTitle =
    conversationOpen && channel
      ? channelTitle(channel)
      : composingOpen
      ? "New conversation"
      : pageOpen && page
      ? page.title
      : tabRoot
        ? spaceName
        : viewLabels[view];
  // A pushed screen (conversation, page, new conversation) is named by its
  // title alone: the Space is the one the list just showed, and a member count
  // under it says nothing about the conversation.
  const mobileSubtitle = showBack || tabRoot ? null : spaceName;
  // A pushed screen's back chevron is cut into the same wood sign as its title.
  const backButton = (showBack || showMoreBack) ? (
    <button
      title={conversationOverPage ? "Back to page" : pageOpen ? "Back to pages" : showBack ? "Back to channels" : "Back to More"}
      aria-label={conversationOverPage ? "Back to page" : pageOpen ? "Back to pages" : showBack ? "Back to channels"
        : "Back to More"}
      className="app-mobile-topbar-back flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card/10 md:hidden"
      onClick={composingOpen ? onCloseComposing : conversationOverPage ? onClosePageConversation
        : pageOpen ? onClosePage : showBack ? onBack : onOpenMore}
    >
      <ChevronLeft className="size-5" />
    </button>
  ) : null;
  return (
    <>
    <header
      className={cn(
        "app-topbar flex h-12 shrink-0 items-center gap-2 bg-background px-3 text-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,36rem)_minmax(0,1fr)]",
        showBack && "app-mobile-channel-detail-bar",
        tabRoot && "app-mobile-tab-root-bar"
      )}
    >
      <div className="relative min-w-0 flex-1 md:hidden">
        <SignWithBack back={backButton}>
        {spaces.length > 1 && !showBack ? (
          <>
            <button
              type="button"
              title="Switch workspace"
              aria-label="Switch workspace"
              aria-haspopup="dialog"
              aria-expanded={spaceMenuOpen}
              onClick={() => setSpaceMenuOpen(true)}
              className="app-mobile-space-trigger flex h-11 w-full min-w-0 items-center gap-2.5 rounded-xl px-1 text-left active:bg-card/10"
            >
              {!currentSpace && (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
                  <Building className="app-mobile-space-trigger-caret size-4" />
                </span>
              )}
              {currentSpace && tabRoot && <Building className="app-mobile-space-glyph shrink-0" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="app-mobile-bar-title min-w-0 truncate text-sm font-black leading-tight">{mobileTitle}</span>
                  {!mobileSubtitle && (
                    <ChevronDown className="app-mobile-space-trigger-caret size-3 shrink-0 text-muted-foreground" />
                  )}
                </span>
                {mobileSubtitle && (
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-semibold leading-tight text-muted-foreground">
                    <span className="truncate">{mobileSubtitle}</span>
                    <ChevronDown className="app-mobile-space-trigger-caret size-3 shrink-0" />
                  </span>
                )}
              </span>
            </button>
            <MobileSpaceSheet
              open={spaceMenuOpen}
              onOpenChange={setSpaceMenuOpen}
              spaces={spaces}
              currentSpaceId={currentSpaceId}
              onSelectSpace={onSelectSpace}
            />
          </>
        ) : (
          <div className={cn("app-mobile-title min-w-0", showBack && "app-mobile-channel-heading")}>
            <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-black" title={mobileTitle}>
              {tabRoot && <Building className="app-mobile-space-glyph shrink-0" aria-hidden="true" />}
              <span className="app-mobile-bar-title min-w-0 truncate">{mobileTitle}</span>
            </p>
            {mobileSubtitle && (
              <p className="truncate text-[11px] text-muted-foreground">{mobileSubtitle}</p>
            )}
          </div>
        )}
        </SignWithBack>
      </div>
      {onOpenSearch && !showBack && (
        // Desktop search is the window's search bar and ⌘F; this icon is the phone's, and the
        // topbar is hidden on desktop. Channel detail bars keep Share / More
        // only — no search.
        <button
          type="button"
          title="Search workspace"
          aria-label="Search workspace"
          onClick={onOpenSearch}
          data-search-anchor=""
          className="app-mobile-search-icon flex size-11 items-center justify-center text-muted-foreground sm:hidden"
        >
          <SearchGlyph className="size-5" />
        </button>
      )}
      {/* Empty on a plank, where it would only push the search glyph off the content line. */}
      <div className="flex items-center gap-0.5 empty:hidden sm:col-start-3 sm:justify-self-end">
        {conversationOpen && channel && onShareChannel && (
          <button
            type="button"
            title={shareCopied ? "Link copied" : "Share"}
            aria-label={shareCopied ? "Link copied" : "Share"}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void (async () => {
                try {
                  await onShareChannel();
                  setShareCopied(true);
                  window.setTimeout(() => setShareCopied(false), 1600);
                } catch {
                  /* clipboard unavailable; leave the control idle */
                }
              })();
            }}
            className="app-mobile-share-button relative z-10 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card/10 hover:text-foreground md:hidden"
          >
            {shareCopied ? <Check className="size-4 text-primary" /> : <Share className="size-4" />}
          </button>
        )}
        {conversationOpen && channel && onOpenChannelDetails && (
          <button
            type="button"
            title="More"
            aria-label="More"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenChannelDetails();
            }}
            className="app-mobile-channel-more-button relative z-10 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card/10 hover:text-foreground md:hidden"
          >
            <MoreHorizontal className="size-5" />
          </button>
        )}
      </div>
      {shareCopied && typeof document !== "undefined" &&
        createPortal(
          <div
            aria-live="polite"
            className="xmatrix-app pointer-events-none fixed bottom-5 left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-xl md:hidden"
          >
            Link copied
          </div>,
          document.body
        )}
    </header>
    </>
  );
}

/* Summary sits on the same paper as the messages, outside their scroller.
   It stays below the fixed-height wood navigation bar and has no card frame. */
export function MobileChannelSummaryPlaque({
  summary,
  onOpen,
  spaceId,
  conversationId,
  token,
  onOpenPage,
}: {
  summary?: string;
  onOpen: () => void;
  spaceId: string;
  conversationId: string;
  token: string | null;
  onOpenPage: (pageId: string) => void;
}) {
  const text = summary?.trim();
  const pages = useConversationPages({ spaceId, conversationId, token });
  if (!text && pages.length === 0) return null;
  /* Summary and linked pages share the paper content inset. No extra
     SUMMARY eyebrow or pin column takes width from the text. */
  return (
    <div className="app-mobile-channel-about-slot relative z-10 shrink-0 md:hidden">
      <div className="app-mobile-channel-about border-0">
        {text && (
          <button
            type="button"
            aria-label="Open channel Summary"
            onClick={onOpen}
            className="app-mobile-channel-about-summary flex w-full items-start gap-2 px-[var(--mobile-content-inset,1rem)] pb-2.5 pt-2.5 text-left active:opacity-80"
          >
            {/* No `block` here: it and line-clamp both set `display`, and the
                clamp needs -webkit-box. Losing that clipped the card mid-line
                instead of ellipsizing. */}
            <span className="min-w-0 flex-1 line-clamp-2 text-sm font-semibold leading-5 text-foreground">
              {text}
            </span>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
        {pages.length > 0 && (
          <div
            className={cn(
              "app-mobile-channel-pages flex gap-1.5 overflow-x-auto px-[var(--mobile-content-inset,1rem)] pb-3",
              !text && "pt-2.5"
            )}
            data-testid="mobile-conversation-pages"
          >
            {pages.map(({ pageId, page, section }) => (
              <button
                key={pageId}
                type="button"
                title={section ? `${page.title} › ${section.title}` : page.title}
                onClick={() => onOpenPage(pageId)}
                className="app-mobile-channel-page-chip flex h-7 max-w-[13rem] shrink-0 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-xs font-semibold active:opacity-80"
              >
                <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{page.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MobileSpaceSheet({
  open,
  onOpenChange,
  spaces,
  currentSpaceId,
  onSelectSpace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: SerializedSpace[];
  currentSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
}) {
  useAndroidBackDismiss(open, () => onOpenChange(false));

  function renderOption(space: SerializedSpace) {
    const selected = space.id === currentSpaceId;
    const memberLabel = `${space.members.length} member${space.members.length === 1 ? "" : "s"}`;
    return (
      <button
        key={space.id}
        type="button"
        role="option"
        aria-selected={selected}
        className={cn("app-mobile-space-option", selected && "app-mobile-space-option-active")}
        onClick={() => {
          onOpenChange(false);
          if (!selected) onSelectSpace(space.id);
        }}
      >
        <SpaceAvatar space={space} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-black leading-5">{space.name}</span>
          <span className="mt-0.5 block truncate text-[11px] font-semibold leading-4 text-muted-foreground">
            {memberLabel}
          </span>
        </span>
        {selected && <Check className="size-4 shrink-0" />}
      </button>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="xmatrix-app app-mobile-space-sheet md:hidden">
        <div className="app-mobile-space-sheet-grabber" aria-hidden="true" />
        <header className="app-mobile-space-sheet-header">
          <h2>Switch workspace</h2>
        </header>
        <div className="app-mobile-space-sheet-list" role="listbox" aria-label="Workspaces">
          {spaces.map(renderOption)}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SpinningLoader({ className }: { className?: string }) {
  return <Loader2 className={cn(className, "animate-spin")} />;
}

/**
 * The rail's update button. The desktop app checks and downloads in the
 * background, so the rail only asks for the one step that needs the person:
 * restarting into a downloaded version. Checking, downloading, errors and
 * "up to date" live in Settings › Desktop.
 */
export function DesktopUpdateRailButton({
  status,
  onInstall,
}: {
  status: DesktopUpdateStatus | null;
  onInstall: () => void;
}) {
  const state = status?.state;
  // "available" comes only from shells that do not download on their own;
  // the button downloads first there.
  if (state !== "downloaded" && state !== "available" && state !== "installing") return null;
  const version = status?.version ? ` ${status.version}` : "";
  const label = state === "installing"
    ? "Restarting to update"
    : state === "available"
      ? `Download xMatrix${version}`
      : `Restart to update to xMatrix${version}`;
  /* Every other rail item is bare ink; the one that asks for something sits
     on a whiter liquid-glass disc the size of the profile avatar, and its
     arrow flies up out of it and a new one rises in from below, every few
     seconds. */
  return (
    <LiquidGlassPill
      as="button"
      title={label}
      aria-label={label}
      disabled={state === "installing"}
      onClick={onInstall}
      material={UPDATE_GLASS}
      className="app-rail-update"
    >
      {state === "installing"
        ? <SpinningLoader className="size-[18px]" />
        : (
          <span className="app-rail-update-window">
            <ArrowUp className="app-rail-update-arrow size-[18px]" strokeWidth={2.25} />
          </span>
        )}
    </LiquidGlassPill>
  );
}

const UPDATE_GLASS: LiquidGlassMaterial = { veil: "oklch(1 0 0 / 0.72)" };

/** Restarting closes every window, so the rail and Settings ask first. */
export function DesktopUpdateRestartDialog({
  status,
  open,
  onCancel,
  onConfirm,
}: {
  status: DesktopUpdateStatus | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <CenteredDialogShell
      open={open && status?.state === "downloaded"}
      busy={false}
      labelledBy="desktop-update-restart-title"
      panelClassName="max-w-sm"
      onCancel={onCancel}
    >
      <DialogPanelHeader
        labelledBy="desktop-update-restart-title"
        title="Restart to update?"
        description="xMatrix will close every window, install the update and reopen."
      />
      <div className="px-5 py-4">
        <DialogInset label="Version">
          <p className="mt-1 font-mono text-sm">
            {status?.currentVersion || "Current"} → {status?.version || "new version"}
          </p>
        </DialogInset>
      </div>
      <DialogPanelFooter>
        <DialogButton onClick={onCancel}>Later</DialogButton>
        <DialogButton tone="primary" icon={CircleArrowUp} onClick={onConfirm}>
          Restart
        </DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}

export function ChannelActionsMenu({
  channel,
  shareUrl,
  moving,
  canManageVisibility,
  updatingVisibility,
  onMove,
  onVisibilityChange,
}: {
  channel: SerializedChannel;
  shareUrl: string;
  moving: boolean;
  canManageVisibility: boolean;
  updatingVisibility: boolean;
  /** Moves the conversation to another Space. */
  onMove: () => void;
  onVisibilityChange: (mode: ChannelCreateMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const title = channelTitle(channel);
  const busy = moving;

  useEffect(() => {
    setOpen(false);
  }, [channel.id]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = canManageVisibility ? 248 : 196;
    const below = rect.bottom + 8;
    setPos({
      right: Math.max(12, Math.min(window.innerWidth - 224 - 12, window.innerWidth - rect.right)),
      top: below + menuHeight <= window.innerHeight
        ? below
        : Math.max(12, rect.top - menuHeight - 8),
    });
  }, [open, canManageVisibility]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function handleCopy() {
    try {
      await copyTextToClipboard(shareUrl);
      setCopied(true);
      setOpen(false);
    } catch {
      /* clipboard unavailable; leave label unchanged */
    }
  }

  function runAction(action: () => void) {
    setOpen(false);
    action();
  }

  function selectVisibility(mode: ChannelCreateMode) {
    setOpen(false);
    if (mode !== channel.mode) onVisibilityChange(mode);
  }

  const itemClassName = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium text-popover-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={`Actions for #${title}`}
        aria-label={`Actions for #${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
        className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {updatingVisibility ? <Loader2 className="size-5 animate-spin" /> : <MoreHorizontal className="size-5" />}
      </button>
      {open && typeof document !== "undefined" && pos &&
        createPortal(
          <div className="pointer-events-none fixed inset-0 z-[var(--z-popover)]">
            <div
              ref={menuRef}
              role="menu"
              aria-label={`Actions for #${title}`}
              className="xmatrix-app pointer-events-auto fixed w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
              style={{ right: pos.right, top: pos.top }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => runAction(onMove)}
                className={itemClassName}
              >
                {moving ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <MoveRight className="size-4 shrink-0 text-muted-foreground" />}
                <span>Move to another Space</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => void handleCopy()}
                className={itemClassName}
              >
                {copied ? <Check className="size-4 shrink-0 text-primary" /> : <Share2 className="size-4 shrink-0 text-muted-foreground" />}
                <span>{copied ? "Copied link" : "Copy channel link"}</span>
              </button>
              <div className="my-1 border-t border-border" role="separator" />
              <div className="px-2.5 pb-1 pt-0.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Visibility
              </div>
              {canManageVisibility ? (
                <>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={channel.mode === "open"}
                    disabled={busy || updatingVisibility}
                    onClick={() => selectVisibility("open")}
                    className={cn(itemClassName, channel.mode === "open" && "bg-muted")}
                  >
                    {updatingVisibility && channel.mode === "open" ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <Hash className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span>Public</span>
                    {channel.mode === "open" && <Check className="ml-auto size-4 text-primary" />}
                  </button>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={channel.mode === "closed"}
                    disabled={busy || updatingVisibility}
                    onClick={() => selectVisibility("closed")}
                    className={cn(itemClassName, channel.mode === "closed" && "bg-muted")}
                  >
                    {updatingVisibility && channel.mode === "closed" ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : (
                      <Lock className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span>Private</span>
                    {channel.mode === "closed" && <Check className="ml-auto size-4 text-primary" />}
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2 px-2.5 py-2 text-sm font-medium text-popover-foreground">
                  {channel.mode === "open" ? (
                    <Hash className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Lock className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span>{channel.mode === "open" ? "Public" : "Private"}</span>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
      {copied && typeof document !== "undefined" &&
        createPortal(
          <div
            aria-live="polite"
            className="xmatrix-app pointer-events-none fixed bottom-5 right-5 z-[var(--z-toast)] rounded-md border border-border bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-xl"
          >
            Copied link
          </div>,
          document.body
        )}
    </>
  );
}

export function ChannelMoveDialog({
  open,
  channel,
  spaces,
  targetSpaceId,
  busy,
  error,
  onTargetSpaceChange,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  channel: SerializedChannel | null;
  spaces: SerializedSpace[];
  targetSpaceId: string;
  busy: boolean;
  error: string | null;
  onTargetSpaceChange: (spaceId: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  useAndroidBackDismiss(open && Boolean(channel), onCancel, busy);

  if (!open || !channel) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-background/55 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold">Move #{channelTitle(channel)}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Move this conversation to another workspace.</p>
          </div>
          <button
            type="button"
            title="Close"
            onClick={onCancel}
            disabled={busy}
            className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block text-sm font-semibold">
            <span className="mb-1 block">Workspace</span>
            <GlassSelect
              value={targetSpaceId}
              onChange={onTargetSpaceChange}
              disabled={busy}
              aria-label="Workspace"
              className="rounded px-2 font-normal"
              options={spaces.map((space) => ({ value: space.id, label: space.name || "Workspace" }))}
            />
          </label>

          <p className="rounded border border-border bg-muted/45 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            A move creates a proposal. Source and destination admins must separately confirm outbound and inbound, even when one person holds both roles. Review access changes on the confirmation card.
          </p>

          {error && (
            <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 rounded border border-border px-3 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !targetSpaceId}
            className="flex h-9 items-center gap-2 rounded bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <MoveRight className="size-4" />}
            {targetSpaceId !== channel.spaceId ? "Create transfer proposal" : "Move"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function ChannelHeader({
  channel,
  spaces,
  currentUserId,
  onRename,
  onVisibilityChange,
  onMove,
  renaming,
  updatingVisibility,
  moving,
  onToggleMembers,
  onOpenSearch,
  actions,
}: {
  channel: SerializedChannel | null;
  spaces: SerializedSpace[];
  currentUserId: string;
  onRename: (name: string) => void;
  onVisibilityChange: (mode: ChannelCreateMode) => void;
  onMove: () => void;
  renaming: boolean;
  updatingVisibility: boolean;
  moving: boolean;
  onToggleMembers: () => void;
  onOpenSearch: () => void;
  /** Controls of where the conversation is shown, such as closing it beside a page. */
  actions?: React.ReactNode;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const channelSpace = channel
    ? spaces.find((space) => space.id === channel.spaceId) || null
    : null;
  const presenceSummary = channel ? memberPresenceSummary(channel, channelSpace) : null;
  const channelHeading = channel ? channelTitle(channel) : "channels";
  const currentUserRole = channelSpace ? spaceRoleFor(channelSpace, currentUserId) : "viewer";
  const canManageVisibility = Boolean(
    channel &&
      (channel.createdBy === currentUserId || currentUserRole === "owner" || currentUserRole === "admin")
  );

  useEffect(() => {
    if (!editingName && channel) {
      setDraftName(channelTitle(channel));
    }
  }, [channel, editingName]);

  function submitRename() {
    if (!channel || renaming) return;
    const nextName = draftName.trim();
    if (!nextName || nextName === channelTitle(channel)) {
      setEditingName(false);
      setDraftName(channelTitle(channel));
      return;
    }
    onRename(nextName);
    setEditingName(false);
  }

  return (
    <div
      className="app-panel-header flex shrink-0 justify-between gap-3 bg-card px-4 py-2"
      style={{ alignItems: "flex-start", height: "auto", minHeight: 0 }}
    >
      <div className="min-w-0 flex-1">
        {editingName && channel ? (
          <form
            className="flex max-w-full items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <Hash className="size-5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={draftName}
              disabled={renaming}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={submitRename}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditingName(false);
                  setDraftName(channelTitle(channel));
                }
              }}
              className="h-8 min-w-0 max-w-full flex-1 rounded border border-border bg-background px-2 text-[18px] font-black leading-none outline-none focus:border-primary"
            />
            <button
              type="submit"
              title="Save channel name"
              disabled={renaming || draftName.trim().length === 0}
              className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              {renaming ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            </button>
          </form>
        ) : (
          <div className="group flex max-w-full items-center gap-1 text-[18px] font-black leading-none md:text-[18px]">
            <Hash className="size-5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {channelHeading}
            </span>
            {channel && (
              <div className="flex shrink-0 items-center gap-1 font-normal">
                <ChannelActionsMenu
                  channel={channel}
                  shareUrl={absoluteChannelUrl(channel, spaces)}
                  moving={moving}
                  canManageVisibility={canManageVisibility}
                  updatingVisibility={updatingVisibility}
                  onMove={onMove}
                  onVisibilityChange={onVisibilityChange}
                />
              </div>
            )}
            {channel && (
              <button
                type="button"
                title={`Rename #${channelTitle(channel)}`}
                onClick={() => {
                  setDraftName(channelTitle(channel));
                  setEditingName(true);
                }}
                disabled={renaming || moving}
                className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-100 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
              >
                {renaming ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
              </button>
            )}
          </div>
        )}
        {channel?.topic && (
          // One line, always: the header has no fixed height, so a topic that
          // wrapped would bounce the timeline below it. Overflow truncates.
          <p className="mt-1 truncate text-[13px] text-muted-foreground">{channel.topic}</p>
        )}
      </div>
      <div className="app-channel-header-actions ml-auto flex shrink-0 items-center justify-end gap-1">
        <button
          type="button"
          title="Channel details"
          aria-label="Channel details"
          onClick={onToggleMembers}
          className="flex h-8 items-center gap-1 rounded px-2 text-sm text-muted-foreground hover:bg-muted xl:hidden"
        >
          <MoreHorizontal className="size-4" />
          {presenceSummary
            ? `${presenceSummary.online}/${presenceSummary.total}`
            : channel
              ? visibleHumanChannelMembers(channel, channelSpace).length
              : 0}
        </button>
        {actions}
        {channel && (
          <button
            type="button"
            title="Search (⌘F / Ctrl+F)"
            aria-label="Search"
            onClick={onOpenSearch}
            data-search-anchor=""
            className="app-channel-search hidden size-8 shrink-0 items-center justify-center rounded border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground md:flex"
          >
            <SearchGlyph className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export function ChannelPresenceAvatars({
  channel,
  events,
  humanMembers,
  avatarItems,
  maxVisible,
}: {
  channel: SerializedChannel;
  events: readonly ObservabilityEvent[];
  humanMembers: string[];
  avatarItems: ChannelAgentAvatarItem[];
  maxVisible?: number;
}) {
  const visibleHumans = maxVisible === undefined
    ? humanMembers.slice(0, 3)
    : humanMembers.slice(0, maxVisible);
  const remainingSlots = maxVisible === undefined
    ? avatarItems.length
    : Math.max(0, maxVisible - visibleHumans.length);
  const visibleAvatarItems = avatarItems.slice(0, remainingSlots);
  const hiddenCount = maxVisible === undefined
    ? Math.max(0, humanMembers.length - visibleHumans.length)
    : Math.max(0, humanMembers.length + avatarItems.length - visibleHumans.length - visibleAvatarItems.length);

  return (
    <div
      className="app-channel-agent-avatars app-channel-presence-avatars flex max-w-[6.75rem] shrink-0 items-center -space-x-1.5 overflow-visible px-0.5"
      onClick={(event) => event.stopPropagation()}
    >
      {visibleHumans.map((member) => {
        const presence = memberPresence(channel, member);
        const label = formatMember(channel, member);
        return (
          <IdentityAvatar
            key={member}
            kind="human"
            label={label}
            status="online"
            imageUrl={presenceAvatarUrl(presence)}
            initials={avatarInitials(label)}
            size="sm"
            showKindBadge={false}
            className="app-channel-human-avatar rounded-full"
          />
        );
      })}
      {visibleAvatarItems.map((item) => {
        const presence = memberPresence(channel, item.member);
        if (presence.kind !== "agent") return null;
        const label = agentInstanceDisplayName(item.instance);
        const status = channelAgentAvatarStatus(channel, item.member, presence, events, item.instance);
        const imageUrl = presenceAvatarUrl(presence);

        return (
          <IdentityAvatar
            key={item.key}
            kind="agent"
            label={label}
            status={status}
            imageUrl={imageUrl}
            initials={imageUrl ? avatarInitials(label) : undefined}
            size="sm"
            showKindBadge={false}
            className="app-channel-agent-avatar rounded-full"
          />
        );
      })}
      {hiddenCount > 0 && (
        <span
          className={cn(
            "app-channel-presence-overflow flex size-8 items-center justify-center text-[10px] font-bold",
            COUNT_CHIP_MATERIAL_CLASS
          )}
        >
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}

export function channelAgentAvatarStatus(
  channel: SerializedChannel,
  member: string,
  presence: ChannelMemberPresence,
  events: readonly ObservabilityEvent[],
  instance?: SerializedAgentInstance
): string {
  const label = presence.label || formatMember(channel, member);
  return agentInstanceDisplayStatus({
    agentId: member,
    channelId: channel.id,
    events,
    instance,
    name: label,
    activity: instance?.activity,
  });
}

/** The conversation's Instances with work in hand, as its row's avatars show: busy, or waiting on something. */
export function channelWorkInHand(channel: SerializedChannel, events: readonly ObservabilityEvent[]) {
  return channelOnlineAgentAvatarItems(channel).flatMap((item) => {
    const presence = memberPresence(channel, item.member);
    if (presence.kind !== "agent" || !item.instance) return [];
    const status = channelAgentAvatarStatus(channel, item.member, presence, events, item.instance);
    return status === "busy" || status === "waiting"
      ? [{ member: item.member, instance: item.instance, presence, status }] : [];
  });
}

export function channelWorkInHandInstanceIds(channel: SerializedChannel, events: ObservabilityEvent[]): string[] {
  return channelWorkInHand(channel, events).map((item) => item.instance.id);
}

export function channelHasWorkInHand(channel: SerializedChannel, events: ObservabilityEvent[]): boolean {
  return channelWorkInHandInstanceIds(channel, events).length > 0;
}

function SignWithBack({ back, children }: { back: React.ReactNode; children: React.ReactNode }) {
  if (!back) return <>{children}</>;
  return <div className="app-mobile-back-sign">{back}{children}</div>;
}

export function SpaceAvatar({ space }: { space: SerializedSpace }) {
  return (
    <span
      className="app-space-avatar flex size-7 shrink-0 items-center justify-center text-[11px] font-black"
      style={spaceAvatarStyle(space)}
      aria-hidden="true"
    >
      {initialsFor(space.name) || "W"}
    </span>
  );
}

/** A tint of the Space's hue with its initials in a deep shade of the same
    hue: the app is light, so pale initials would vanish into the tint. The
    edge is an inset shadow, not a border: `.rounded-md.border` is the app's
    card selector, and its material would paint over the tint. */
export function spaceAvatarStyle(space: SerializedSpace): CSSProperties {
  const seed = space.id || space.name;
  const hue = Array.from(seed).reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return {
    backgroundColor: `hsl(${hue} 70% 42% / 0.16)`,
    boxShadow: `inset 0 0 0 1px hsl(${hue} 70% 42% / 0.3)`,
    color: `hsl(${hue} 70% 28%)`,
  };
}

export function spaceDisambiguatorId(id: string): string {
  if (id.length <= 6) return `#${id}`;
  return `#${id.slice(-4)}`;
}

export type { ChannelAgentAvatarItem } from "./workspace-shell-message-model";
import type { ChannelAgentAvatarItem } from "./workspace-shell-message-model";

export function useCatalogSearch(open: boolean, query: string, catalogPaging: SpaceChannelCatalog) {
  useEffect(() => {
    const normalized = normalizeChannelSearchText(query);
    if (!open || !normalized) return;
    const timer = window.setTimeout(() => { void catalogPaging.load({ view: "search", query: normalized }); }, 150);
    return () => window.clearTimeout(timer);
  }, [catalogPaging, open, query]);
}

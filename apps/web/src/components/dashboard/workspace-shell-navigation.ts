"use client";

import {
  decodePathSegment,
} from "./workspace-shell-path";
import { pointerActivationAlreadyHandled } from "./pointer-activation-guard";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";































import {
  channelAppPath,
  spaceAppPath,
} from "@/components/dashboard/channel-links";


























import type {
  ObservabilityEvent,
  SerializedChannel,
  SerializedSpace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)


export const MOBILE_CHANNEL_ACTION_LONG_PRESS_MS = 420;


export const MOBILE_CHANNEL_ACTION_MOVE_TOLERANCE_PX = 10;


// A channel tapped on the cold-start disk catalog opens as soon as the
// authenticated list resolves that id. Past this window the tap is forgotten:
// a late catalog must not yank the user into a screen they asked for minutes
// ago and already moved on from.
export const PENDING_CHANNEL_NAVIGATION_TTL_MS = 15_000;


/* Cold start paints the disk catalog while the authenticated channel list is
   still in flight, and navigation only resolves ids from that authenticated
   list. Dropping the tap left those rows looking dead — press highlight, no
   navigation — so the intent is remembered here and lands the moment the real
   channel arrives. The pending id is returned so the row can stay highlighted
   while it waits. */
export function usePendingChannelNavigation(
  channels: SerializedChannel[],
  channelsRef: MutableRefObject<SerializedChannel[]>,
  navigateToChannel: (channelId: string, messageId?: string) => void
): {
  requestChannelNavigation: (channelId: string, messageId?: string) => void;
  pendingChannelNavigationId: string | null;
} {
  const pendingRef = useRef<{ channelId: string; messageId?: string; requestedAt: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const navigateRef = useRef(navigateToChannel);
  const [pendingChannelNavigationId, setPendingChannelNavigationId] = useState<string | null>(null);

  navigateRef.current = navigateToChannel;

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPendingChannelNavigationId(null);
  }, []);

  const requestChannelNavigation = useCallback((channelId: string, messageId?: string) => {
    if (!messageId && pointerActivationAlreadyHandled(channelId)) return;
    if (channelsRef.current.some((channel) => channel.id === channelId)) {
      clearPending();
      navigateRef.current(channelId, messageId);
      return;
    }
    pendingRef.current = { channelId, messageId, requestedAt: Date.now() };
    setPendingChannelNavigationId(channelId);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(clearPending, PENDING_CHANNEL_NAVIGATION_TTL_MS);
  }, [channelsRef, clearPending]);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (Date.now() - pending.requestedAt > PENDING_CHANNEL_NAVIGATION_TTL_MS) {
      clearPending();
      return;
    }
    if (!channels.some((channel) => channel.id === pending.channelId)) return;
    clearPending();
    navigateRef.current(pending.channelId, pending.messageId);
  }, [channels, clearPending]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { requestChannelNavigation, pendingChannelNavigationId };
}


export type AppView =
  | "pages"
  | "messages"
  | "local"
  | "machines"
  | "automation"
  | "status"
  | "agents"
  | "apps"
  | "activity"
  | "team"
  /** A member's profile, viewer's own or a colleague's. Replaces the popovers. */
  | "profile"
  | "settings"
  | "admin"
  | "more";



// The mobile dock's tabs, in its order: each one's own screen is named by the
// dock, so its top bar carries only the Space.
/** Destinations that show their own list beside the chosen item, in the conversation list's place. */
export const SPLIT_TOOL_VIEWS: readonly AppView[] = ["automation", "settings", "admin", "machines", "local", "apps", "agents", "team"];

export const DOCK_TAB_VIEWS: readonly AppView[] = ["pages", "messages", "status", "more"];

// Views that live behind the mobile "More" dock tab: the hub screen itself plus
// every root view without a dedicated dock tab. The dock highlights "More" for
// all of them, and the mobile topbar shows a back-to-More chevron on children.
export const MORE_TAB_VIEWS: readonly AppView[] = [
  "more",
  "activity",
  "agents",
  "machines",
  "automation",
  "apps",
  "team",
  "profile",
  "settings",
  "admin",
];



export const MOBILE_MORE_RETURN_PATH_STATE_KEY = "__xmatrixMobileMoreReturnPath";



export const viewLabels: Record<AppView, string> = {
  pages: "Pages",
  messages: "Channels",
  local: "This Machine",
  machines: "Machines",
  automation: "Schedules",
  status: "Status",
  agents: "Agents",
  apps: "App",
  activity: "Activity",
  team: "Team",
  profile: "Profile",
  settings: "Settings",
  admin: "Platform admin",
  more: "More",
};



/**
 * Route segments that were renamed. A link someone already shared has to keep
 * landing on the replacement rather than falling through as an unknown path.
 *
 * `direct` was a dedicated Direct-messages destination; those conversations
 * now live in the Channels sidebar, so old `/direct` URLs open Channels.
 * `roles` was the Agents screen's segment while Agents could be given Roles.
 * Roles are retired, but published iOS builds still send
 * `roles` for their Agents tab and bookmarks still carry it, so it opens
 * Agents. Remove it once no supported native build sends `roles`.
 */
export const LEGACY_VIEW_SEGMENTS: Record<string, AppView> = {
  direct: "messages",
  roles: "agents",
};

/** The view a route segment names, following a rename. `null` when it names none. */
export function viewForRouteSegment(value: string | null): AppView | null {
  if (!value) return null;
  const renamed = LEGACY_VIEW_SEGMENTS[value];
  if (renamed) return renamed;
  return isAppView(value) ? value : null;
}

export function isAppView(value: string | null): value is AppView {
  return (
    value === "pages" ||
    value === "messages" ||
    value === "local" ||
    value === "machines" ||
    value === "automation" ||
    value === "status" ||
    value === "agents" ||
    value === "apps" ||
    value === "activity" ||
    value === "team" ||
    value === "profile" ||
    value === "settings" ||
    value === "admin" ||
    value === "more"
  );
}



export type AppRouteInfo = {
  spaceKey: string | null;
  channelKey: string | null;
  legacyChannelId: string | null;
  /** The conversation open beside a page (`/pages?page=…&conversation=…`). */
  conversationKey: string | null;
  view: AppView;
};



export function appRouteInfo(location: string): AppRouteInfo {
  const url = parseAppLocation(location);
  const segments = url.pathname.split("/").filter(Boolean).map(decodePathSegment);
  const legacyChannelId = url.searchParams.get("channel")?.trim() || null;
  const queryView = url.searchParams.get("view");
  const fallbackView = viewForRouteSegment(queryView) || "messages";

  if (segments[0] !== "app") {
    return { spaceKey: null, channelKey: null, legacyChannelId, conversationKey: null, view: fallbackView };
  }

  const spaceKey = segments[1] || null;
  const appChildSegment = segments[2] || null;
  const channelKey = appChildSegment === "channels" || appChildSegment === "c"
    ? segments[3] || null
    : null;

  const segmentView = viewForRouteSegment(appChildSegment);
  let view: AppView = fallbackView;
  if (channelKey || legacyChannelId) {
    view = "messages";
  } else if (segmentView) {
    view = segmentView;
  } else if (segments.length === 2) {
    view = "messages";
  }
  // A conversation opens beside the page it is about (pages-live-document.md §4.4).
  const conversationKey = view === "pages" ? pagesViewSelection(location).conversationId : null;

  return { spaceKey, channelKey, legacyChannelId, conversationKey, view };
}

/** Whether a view shows the selected conversation: its own view, or docked beside a page. */
export function conversationViewOpen(view: AppView): boolean {
  return view === "messages" || view === "pages";
}

/** The Pages view's address: the open page and the conversation open beside it. */
export function pagesViewPath(spacePath: string, pageId: string | null, conversationId: string | null): string {
  const query = new URLSearchParams();
  if (pageId) query.set("page", pageId);
  if (pageId && conversationId) query.set("conversation", conversationId);
  const search = query.toString();
  return search ? `${spacePath}?${search}` : spacePath;
}

/** A list destination's address names the item open in it (`?item=<key>`), so it can be shared. */
export function toolItemPath(viewPath: string, item: string | null): string {
  return item ? `${viewPath}?item=${encodeURIComponent(item)}` : viewPath;
}

/** The item a list destination's address names; the reverse of `toolItemPath`. */
export function toolItemSelection(location: string): string | null {
  return parseAppLocation(location).searchParams.get("item")?.trim() || null;
}

/** What a Pages view address names; the reverse of `pagesViewPath`. */
export function pagesViewSelection(location: string): { pageId: string | null; conversationId: string | null } {
  const query = parseAppLocation(location).searchParams;
  return {
    pageId: query.get("page"),
    conversationId: query.get("conversation")?.trim() || null,
  };
}



export function appViewPath(
  channel: SerializedChannel | null,
  view: AppView,
  routeSpaceId: string | null,
  spaces: SerializedSpace[]
): string {
  const spacePath = view === "messages" && channel
    ? spaceAppPath(channel.spaceId, spaces)
    : routeSpaceId
      ? spaceAppPath(routeSpaceId, spaces)
      : channel
        ? spaceAppPath(channel.spaceId, spaces)
        : "/app";

  if (view === "messages") {
    if (channel) return channelAppPath(channel, spaces);
    return routeSpaceId ? `${spacePath}/channels` : spacePath;
  }
  return `${spacePath}/${encodeURIComponent(view)}`;
}



export const MOBILE_CHANNEL_LIST_RETURN_PATH_STATE_KEY = "__xmatrixMobileChannelListReturnPath";

export const MOBILE_CHANNEL_DETAILS_RETURN_PATH_STATE_KEY = "__xmatrixMobileChannelDetailsReturnPath";

export const MOBILE_CHANNEL_DETAILS_HASH = "#channel-details";

export function isMobileChannelDetailsHistoryState(state: unknown, path: string): boolean {
  return Boolean(
    state &&
    typeof state === "object" &&
    (state as Record<string, unknown>)[MOBILE_CHANNEL_DETAILS_RETURN_PATH_STATE_KEY] === path
  );
}

export function isMobileChannelDetailsLocation(hash = typeof window === "undefined" ? "" : window.location.hash): boolean {
  return hash === MOBILE_CHANNEL_DETAILS_HASH;
}

export function pushBrowserPath(path: string, state?: Record<string, unknown>) {
  if (currentBrowserLocation() === path) return;
  window.history.pushState(state ? { ...window.history.state, ...state } : null, "", path);
}

/** Overlay history entry. `url` should differ from the current href so Next.js and WKWebView keep it. */
export function pushBrowserHistoryState(state: Record<string, unknown>, url?: string) {
  if (typeof window === "undefined") return;
  window.history.pushState(
    { ...window.history.state, ...state },
    "",
    url ?? `${window.location.pathname}${window.location.search}${window.location.hash}`
  );
}



export function replaceBrowserPath(path: string) {
  if (currentBrowserLocation() === path) return;
  window.history.replaceState(null, "", path);
}



export function clearBrowserHash() {
  if (typeof window === "undefined" || !window.location.hash) return;
  window.history.replaceState(null, "", currentBrowserLocation());
}



export { appLinkMessageIdFromHash } from "./channel-links";



export function currentBrowserLocation(fallbackPath = "/app"): string {
  if (typeof window === "undefined") return fallbackPath;
  return `${window.location.pathname}${window.location.search}`;
}



export function currentLoginReturnPath(fallbackPath = "/app"): string {
  if (typeof window === "undefined") return fallbackPath;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}



export function parseAppLocation(location: string): URL {
  return new URL(location || "/app", "https://xmatrix.local");
}



export function notificationPathForEvent(
  event: ObservabilityEvent,
  channels: SerializedChannel[],
  spaces: SerializedSpace[],
  routeSpaceId: string | null
): string {
  if (event.channelId) {
    const channel = channels.find((item) => item.id === event.channelId);
    if (channel) return channelAppPath(channel, spaces);
  }

  if (routeSpaceId) {
    return `${spaceAppPath(routeSpaceId, spaces)}/activity`;
  }

  return "/app";
}

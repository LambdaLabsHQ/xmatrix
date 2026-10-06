# Mobile App UI Architecture

This document records the mobile information architecture and shell rules for the xMatrix web app embedded by iOS and Android. The native clients load the same `/app/**` web surface, so browser history, safe areas, and responsive CSS are part of the native navigation contract.

## Product principles

1. Mobile is action-first. Chats, agents, apps, and the overflow hub remain one tap away.
2. Navigation labels must describe their contents. Mixed workspace administration belongs under **More**, not under a personal **Me** destination.
3. Every mobile screen must be reachable without a hand-authored URL. Device-local setup is explicitly desktop-only.
4. A screen has one title. The mobile top bar is the single title source, and content must clear fixed chrome.
5. Liquid glass is a single floating surface layer. Content cards inside glass chrome stay solid, tinted, or outlined.
6. Android back, iOS swipe-back, and visible back buttons must produce the same hierarchy without history loops.

## Information architecture

The web dock and the iOS native tab bar have the same four destinations, in
the order of the desktop rail. Pages come first and are where the app opens
when nothing more specific is asked for; a link to a conversation or a page,
or a restored place, opens there instead. There are no direct messages: people
and Agents are reached in a conversation. The tabs:

```text
Pages   Channels   Agents   More
                            ├─ Workspace
                            │  ├─ Activity
                            │  ├─ Team
                            │  └─ Apps
                            ├─ Operations
                            │  ├─ Machines
                            │  └─ Schedules
                            └─ Account
                               └─ Settings
```

On iOS every tab is its own page, created on first visit and kept while the
user moves between tabs. Every tab follows the Space the user is in: a tab last
seen in another Space moves to the current one when it is shown. Changing
account discards the hidden pages.

`Overview` was removed. It repeated counts and links already available in the purpose-specific destinations, consumed a full screen, and had no primary user action. A bare workspace URL resolves to Channels instead.

The count-only Analytics screen was removed together with the earlier Overview screen. Neither offered a decision or next action. Settings, team management, automation, activity, and the machine fleet remain reachable from More.

`This Machine` is not a mobile destination. It manages the local daemon, filesystem directories, runtimes, and desktop setup state, which require device-local capabilities that a phone cannot act on. The route and desktop rail entry remain available to desktop clients; the mobile dock does not expose it.

## Information quality contract

App content must help the user act, choose, or diagnose. Standalone totals, rankings, workspace snapshots, raw internal identifiers, and duplicate summary badges do not qualify and should not occupy cards or page headers.

Counts remain appropriate only when they change an immediate interaction: unread and mention badges, collection scope, child navigation, member context, quotas, progress, or error state. Operational details remain appropriate when they explain health, permissions, risk, ownership, or the next valid action.

## Shell layers

```text
Native WebView
└─ .xmatrix-app
   ├─ ambient background
   ├─ fixed top workspace bar                 --z-nav
   ├─ current screen
   │  ├─ Pages screen (the list; an opened document is pushed)
   │  ├─ Chats screen
   │  └─ ToolSurface screen
   ├─ fixed mobile tab dock                   --z-nav
   ├─ sheets and dialogs, portaled to body    --z-overlay
   ├─ menus and suggestions                   --z-popover
   └─ notifications                           --z-toast
```

Tool surfaces reserve both fixed chrome regions through `--mobile-topbar-space`, `--mobile-dock-float-offset`, and the device safe-area variables. Chat is the only screen allowed to visually continue behind glass chrome, because its timeline has its own composer and scroll-padding contract.

The create button on a dock tab sits just above the dock, sharing its right edge with 12px of clearance. It is a wood plank of the same stock as the top bar (opaque grain, no backdrop blur). The dock itself stays the light glass capsule. On iOS that capsule floats on the screen bottom, inset so its corners are concentric with the device corners; the button's bottom offset is the capsule's top plus 12px, using the height the app measures above the home indicator and the capsule's side gap.

## Stacking contract

All new floating UI must use the shared ladder:

```css
--z-content: 0;
--z-raised: 10;
--z-nav: 40;
--z-overlay: 50;
--z-popover: 60;
--z-toast: 70;
```

Do not add numeric z-index literals or intermediate `calc(... + 1)` layers. Components using Tailwind arbitrary values should reference the token directly, for example `z-[var(--z-popover)]`. Overlay and higher layers must escape local stacking contexts through a portal.

## Navigation contract

`WorkspaceAppShell` currently synchronizes `AppView` with the History API. Until this becomes a dedicated tab-and-stack reducer, navigation must observe these rules:

- Selecting a dock destination pushes one history entry.
- A phone keeps one mounted pane per dock tab and slides between them, so switching a tab is orthogonal: it neither rebuilds nor refetches the screen it leaves. Pages, Channels, Agents, and More each own their pane (Agents and More each render their own tool surface). A pane mounts the first time its tab is shown and then stays; Pages is not mounted at startup, because its tree prefetches page documents.
- Opening a More child pushes an entry whose `__xmatrixMobileMoreReturnPath` state stores its parent URL.
- The visible **Back to More** action uses browser back for a marked entry, preserving native swipe and Android back behavior.
- A directly loaded More child has no parent entry, so **Back to More** replaces the current URL instead of adding another entry.
- Opening mobile Summary or channel info pushes one `#channel-details` history entry whose `__xmatrixMobileChannelDetailsReturnPath` state stores the current channel path, so iOS swipe-back, Android Back, and the overlay close action return to the message column instead of the channel list.
- A bare workspace URL represents Chats; it must not recreate a removed overview screen.

The long-term target is an explicit `{ tab, stack }` navigation state where detail screens push, back pops, and dock visibility derives from stack depth.

## Screen-title contract

Desktop tool screens may retain material title plaques. On phones, the fixed top bar is the single screen-title source and `.app-page-title` is hidden. This avoids a second material slab directly beneath floating navigation and removes the duplicated-header appearance. A future large-title collapse must replace this contract as one coordinated screen primitive; it must not introduce a second simultaneous title.

## Overlay contract

Sheets and dialogs use one overlay layer, support Escape, and expose a clear dismiss action. Menus and autocomplete panels use the popover layer. Transient confirmations use the toast layer. Mobile channel **More** opens `ChannelDetails` as a full-screen overlay portaled to `document.body` (same content as the desktop right rail: About, Members, Agents, Connectors, Automation) so it cannot fall below the dock because of an ancestor stacking context.

## Validation

Mobile shell changes should cover at least:

- each dock destination and its active state;
- More-to-child and child-to-More navigation;
- browser back after using the visible back button;
- swipe-back / history.back() from Summary or channel details returning to the message column;
- direct loading of a More child;
- title clearance below the top bar and content clearance above the dock;
- sheet visibility above both chrome surfaces;
- iPhone safe-area and Android hardware-back behavior.

The focused Playwright coverage lives in `apps/web/e2e/mobile-primary-navigation.spec.ts` and the other `mobile-*.spec.ts` files.

## Follow-up architecture work

The shell is still concentrated in `workspace-app-shell.tsx`. Future work should extract the shell, top bar, dock, screen frame, and navigation state before splitting data domains. Overlay primitives and toast behavior should then be consolidated without changing the information architecture above.

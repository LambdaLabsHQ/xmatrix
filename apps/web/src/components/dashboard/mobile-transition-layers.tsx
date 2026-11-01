"use client";

import { useLayoutEffect, useSyncExternalStore, type ComponentProps, type MutableRefObject } from "react";
import type { SerializedSpace } from "@xmatrix/protocol";

import type { CreateAction } from "./list-create";
import { slideDockTabBars, type DockTabSlideStore } from "./use-dock-tab-slide";
import type { MobileListTransitionStore } from "./use-mobile-list-transition";
import { CreateFab, MobileTabDock, TopWorkspaceBar } from "./workspace-shell-chrome";
import { DOCK_TAB_VIEWS, type AppView } from "./workspace-shell-navigation";

const noServerSnapshot = () => null;

/** What every dock tab's own bar shows: the Space's sign and search. */
type TabRootBar = {
  spaces: SerializedSpace[];
  currentSpaceId: string | null;
  onOpenSearch: () => void;
  onSelectSpace: (spaceId: string) => void;
  onBack: () => void;
  onOpenMore: () => void;
};

/**
 * The channel list's own bar and controls, drawn over the conversation's
 * while the two trade places (use-mobile-list-transition): the bar inert and
 * unread, the + and the web dock out of reach until the list is the screen.
 * It renders on its own, so starting or ending the change does not render the
 * shell around it.
 */
export function MobileListTransitionLayer({ store, bar, listCreate, webDock, statusLive, onChangeView }: {
  store: MobileListTransitionStore;
  bar: TabRootBar;
  /** The list's + (a new conversation). */
  listCreate: CreateAction | null;
  /** This client draws the web dock; the iOS app draws its own tab bar. */
  webDock: boolean;
  statusLive: boolean;
  onChangeView: (view: AppView) => void;
}) {
  const stage = useSyncExternalStore(store.subscribe, store.get, noServerSnapshot);
  if (!stage) return null;
  return (
    <>
      {/* The conversation bar's paper, which clears as the list arrives under it. */}
      <div className="app-list-transition-band" aria-hidden="true" />
      <TopWorkspaceBar ghost="app-list-transition-target" channel={null} view="messages" {...bar} />
      <div className="app-list-transition-controls contents" inert aria-hidden="true">
        <CreateFab action={listCreate} />
        {webDock && <MobileTabDock activeView="messages" statusLive={statusLive} onChangeView={onChangeView} />}
      </div>
      {/* Set up for a swipe that may not come, the page still takes taps. */}
      {stage !== "prepared" && <div className="app-list-transition-shield" aria-hidden="true" />}
    </>
  );
}

/** The web dock, marking the tab a slide is going to from the moment it starts (use-dock-tab-slide). */
export function SlidingMobileTabDock({ slide, activeView, ...dock }: ComponentProps<typeof MobileTabDock> & {
  slide: DockTabSlideStore;
}) {
  const pendingSlot = useSyncExternalStore(slide.pending.subscribe, slide.pending.get, noServerSnapshot);
  return <MobileTabDock activeView={DOCK_TAB_VIEWS[pendingSlot ?? -1] ?? activeView} {...dock} />;
}

/** The bar of the dock tab being left, sliding out with its page (use-dock-tab-slide). */
export function DockTabSlideLayer({ store, rootRef, view, bar }: {
  store: DockTabSlideStore;
  rootRef: MutableRefObject<HTMLElement | null>;
  view: AppView;
  bar: TabRootBar;
}) {
  const slide = useSyncExternalStore(store.subscribe, store.get, noServerSnapshot);
  useLayoutEffect(() => {
    if (!slide) return;
    const leaving = rootRef.current ? slideDockTabBars(rootRef.current, slide) : null;
    const clear = () => {
      if (store.get() === slide) store.set(null);
    };
    if (leaving) leaving.finished.then(clear, clear);
    else clear();
  }, [rootRef, slide, store]);
  if (!slide) return null;
  return <TopWorkspaceBar key={slide.key} ghost="app-dock-tab-slide-outgoing" channel={null} view={view} {...bar} />;
}

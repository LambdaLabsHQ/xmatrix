"use client";

import { useEffect, useRef, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { CalendarClock, Flag, Link2, MessageSquarePlus, PenLine } from "lucide-react";
import { listenForOverlayDismissal } from "@/components/dashboard/use-overlay-dismiss";
import { PaperPopover } from "@/components/ui/material-surfaces";

/** What a heading offers on a phone, each said in words. */
export interface HeadingMenu {
  write?: { label: string; run: () => void };
  discuss?: () => void;
  copyLink?: () => void;
  claim?: { label: string; run: () => void };
  attach?: () => void;
}

/** A row's height: a thumb's target. */
const ITEM_HEIGHT = 44;

interface Item { key: string; label: string; icon: ComponentType<{ className?: string }>; run: () => void }

function items(menu: HeadingMenu): Item[] {
  const list: Item[] = [];
  if (menu.write) list.push({ key: "write", label: menu.write.label, icon: PenLine, run: menu.write.run });
  if (menu.discuss) list.push({ key: "discuss", label: "Discuss", icon: MessageSquarePlus, run: menu.discuss });
  if (menu.copyLink) list.push({ key: "link", label: "Copy link", icon: Link2, run: menu.copyLink });
  if (menu.claim) list.push({ key: "claim", label: menu.claim.label, icon: Flag, run: menu.claim.run });
  if (menu.attach) list.push({ key: "attach", label: "Schedule", icon: CalendarClock, run: menu.attach });
  return list;
}

function HeadingMenuPopup({ anchor, title, menu, onClose }: {
  anchor: HTMLElement; title: string; menu: HeadingMenu; onClose: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The page scrolling away from the heading takes its menu with it.
    const scrolled = () => onClose();
    window.addEventListener("scroll", scrolled, { capture: true, passive: true });
    const stop = listenForOverlayDismissal((event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (anchor.contains(target) || popup.current?.contains(target))) return;
      onClose();
    }, onClose);
    return () => { window.removeEventListener("scroll", scrolled, { capture: true }); stop(); };
  }, [anchor, onClose]);
  const place = anchor.getBoundingClientRect();
  const list = items(menu);
  // Below the "⋯", or above it when the window has no room below.
  const height = list.length * ITEM_HEIGHT + 14;
  const below = place.bottom + 6 + height <= (window.visualViewport?.height ?? window.innerHeight) - 12;
  return createPortal(
    <PaperPopover ref={popup} role="menu" aria-label={`Actions for ${title}`}
      className="xmatrix-app page-heading-menu fixed z-[var(--z-popover)] w-56 p-1.5"
      style={{ ...(below ? { top: place.bottom + 6 } : { bottom: window.innerHeight - place.top + 6 }),
        right: Math.max(12, window.innerWidth - place.right) }}>
      {list.map(({ key, label, icon: Icon, run }) => (
        <button key={key} type="button" role="menuitem" onClick={() => { onClose(); run(); }}
          className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-[15px] font-medium">
          <Icon className="size-[18px] shrink-0 text-muted-foreground" />
          <span>{label}</span>
        </button>
      ))}
    </PaperPopover>,
    anchor.ownerDocument.body,
  );
}

/**
 * On a phone a heading's tools are not a row of bare icons: one "⋯" beside the heading of the section
 * the reader is in opens them as a menu of named actions, the app's own menu, floating over the page.
 */
export function mountHeadingMenu(holder: HTMLElement, anchor: HTMLElement, title: string, menu: HeadingMenu,
  onClose: () => void): () => void {
  const root = createRoot(holder);
  root.render(<HeadingMenuPopup anchor={anchor} title={title} menu={menu} onClose={onClose} />);
  // The editor drops a widget while React may be rendering; unmount after it.
  return () => queueMicrotask(() => root.unmount());
}

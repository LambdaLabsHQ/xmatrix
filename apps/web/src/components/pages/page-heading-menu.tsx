"use client";

import { createRoot } from "react-dom/client";
import { CalendarClock, Flag, Link2, MessageSquarePlus } from "lucide-react";
import { MobileInlineActions, type MobileInlineAction } from "@/components/dashboard/mobile-inline-actions";

/** What a heading offers on a phone, each said in words. */
export interface HeadingMenu {
  discuss?: () => void;
  copyLink?: () => void;
  claim?: { label: string; run: () => void };
  attach?: () => void;
}

/**
 * On a phone a heading's tools are not a row of bare icons: "⋯" opens them under the heading,
 * as a tapped message's actions open under it, each with its name.
 */
export function mountHeadingMenu(element: HTMLElement, title: string, menu: HeadingMenu, close: () => void): () => void {
  const actions: MobileInlineAction[] = [];
  const then = (run: () => void) => () => { close(); run(); };
  if (menu.discuss) actions.push({ key: "discuss", icon: MessageSquarePlus, label: "Discuss", onSelect: then(menu.discuss) });
  if (menu.copyLink) actions.push({ key: "link", icon: Link2, label: "Copy link", onSelect: then(menu.copyLink) });
  if (menu.claim) actions.push({ key: "claim", icon: Flag, label: menu.claim.label, onSelect: then(menu.claim.run) });
  if (menu.attach) actions.push({ key: "attach", icon: CalendarClock, label: "Schedule", onSelect: then(menu.attach) });
  const root = createRoot(element);
  root.render(<MobileInlineActions label={`Actions for ${title}`} actions={actions} />);
  return () => queueMicrotask(() => root.unmount());
}

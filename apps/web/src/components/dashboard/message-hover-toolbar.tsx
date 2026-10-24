"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, MoreHorizontal, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";

import { PaperPopover } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

import { listenForOverlayDismissal } from "./use-overlay-dismiss";
import { QUICK_REACTION_EMOJIS } from "./workspace-shell-constants";

/** On the bar itself, one click each: the answers a reader gives most. */
const BAR_REACTIONS = ["👍", "✅", "👀"];
const PICKER_REACTIONS = QUICK_REACTION_EMOJIS.filter((emoji) => !BAR_REACTIONS.includes(emoji));

/** How far `-top-6` lifts the bar above its row. */
const EDGE_OVERHANG = 24;

const BUTTON_CLASS_NAME =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground";
const MENU_ITEM_CLASS_NAME =
  "flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm";

/** A key pressed over a message acts on it, unless it is typing or a chord. */
function isRowShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
    return false;
  }
  return window.getSelection()?.isCollapsed !== false;
}

/* A message's desktop actions: one card of white paper riding the row's top
   edge, the same place for a row with a header and one without. Above the
   row, not on it, so the first line it would cover stays readable; what it
   covers instead is the end of the line before, which is usually short. Paper,
   not glass: glass over text blurs it into a smudge (user 2026-10-24). Edit and
   Recall wait behind "⋯", so the bar keeps one length and a destructive action
   is never one stray click away. */
export function MessageHoverToolbar({
  copied,
  onCopy,
  onReply,
  onReact,
  onEdit,
  onRecall,
}: {
  copied: boolean;
  onCopy: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onEdit?: () => void;
  onRecall?: () => void;
}) {
  const [open, setOpen] = useState<"reactions" | "menu" | null>(null);
  // Riding the edge would put it past the top of the timeline, which clips it.
  const [inside, setInside] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const actions = useRef({ onCopy, onReply, onEdit });
  actions.current = { onCopy, onReply, onEdit };

  useEffect(() => {
    if (!open) return;
    return listenForOverlayDismissal((event) => {
      if (event.target instanceof Node && frameRef.current?.contains(event.target)) return;
      setOpen(null);
    }, () => setOpen(null));
  }, [open]);

  // R, C and E act on the message under the pointer, as their titles say.
  // Entering also settles where the bar goes, measured then, not on scroll.
  useEffect(() => {
    const row = frameRef.current?.closest<HTMLElement>(".app-message-row");
    if (!row) return;
    const keydown = (event: KeyboardEvent) => {
      if (!isRowShortcut(event)) return;
      const key = event.key.toLowerCase();
      const run = key === "r" ? actions.current.onReply
        : key === "c" ? actions.current.onCopy
        : key === "e" ? actions.current.onEdit
        : undefined;
      if (!run) return;
      event.preventDefault();
      run();
    };
    const enter = () => {
      const timeline = row.closest(".app-message-timeline");
      if (timeline) setInside(row.getBoundingClientRect().top - EDGE_OVERHANG < timeline.getBoundingClientRect().top);
      document.addEventListener("keydown", keydown);
    };
    const leave = () => document.removeEventListener("keydown", keydown);
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    if (row.matches(":hover")) enter();
    return () => {
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      leave();
    };
  }, []);

  const react = (emoji: string) => {
    setOpen(null);
    onReact(emoji);
  };
  const toggle = (which: "reactions" | "menu") => setOpen((current) => current === which ? null : which);
  const hasMenu = Boolean(onEdit || onRecall);

  return (
    <div
      ref={frameRef}
      className={cn(
        // Hidden means untouchable too: the bar hangs over the row above, whose
        // pointer must not wake this row's bar.
        "app-message-hover-toolbar pointer-events-none absolute right-5 z-10 hidden opacity-0 transition-opacity md:block",
        "group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
        inside ? "top-1" : "-top-6",
        open && "pointer-events-auto opacity-100",
      )}
    >
      <PaperPopover role="toolbar" aria-label="Message actions" className="flex items-center rounded-full p-0.5">
        {BAR_REACTIONS.map((emoji) => (
          <button key={emoji} type="button" title={`React ${emoji}`} aria-label={`React ${emoji}`}
            className={cn(BUTTON_CLASS_NAME, "text-[15px]")} onClick={() => react(emoji)}>
            {emoji}
          </button>
        ))}
        <button type="button" title="Add reaction" aria-label="Add reaction" aria-expanded={open === "reactions"}
          aria-pressed={open === "reactions"} className={BUTTON_CLASS_NAME} onClick={() => toggle("reactions")}>
          <SmilePlus className="size-3.5" />
        </button>
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-foreground/15" />
        <button type="button" title="Reply (R)" aria-label="Reply" className={BUTTON_CLASS_NAME} onClick={onReply}>
          <Reply className="size-3.5" />
        </button>
        <button type="button" title={copied ? "Copied" : "Copy message (C)"} aria-label={copied ? "Copied" : "Copy message"}
          className={BUTTON_CLASS_NAME} onClick={onCopy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        {hasMenu && (
          <button type="button" title="More actions" aria-label="More actions" aria-haspopup="menu"
            aria-expanded={open === "menu"} aria-pressed={open === "menu"} className={BUTTON_CLASS_NAME}
            onClick={() => toggle("menu")}>
            <MoreHorizontal className="size-3.5" />
          </button>
        )}
      </PaperPopover>
      {open === "reactions" && (
        <PaperPopover role="toolbar" aria-label="Quick reactions"
          className="absolute right-0 top-full mt-1 flex rounded-full p-0.5">
          {PICKER_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" aria-label={`React ${emoji}`}
              className={cn(BUTTON_CLASS_NAME, "text-[15px]")} onClick={() => react(emoji)}>
              {emoji}
            </button>
          ))}
        </PaperPopover>
      )}
      {open === "menu" && (
        <PaperPopover role="menu" aria-label="More message actions"
          className="absolute right-0 top-full mt-1 w-44 p-1">
          {onEdit && (
            <button type="button" role="menuitem" className={MENU_ITEM_CLASS_NAME}
              onClick={() => { setOpen(null); onEdit(); }}>
              <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1">Edit</span>
              <kbd className="font-sans text-xs text-muted-foreground">E</kbd>
            </button>
          )}
          {onRecall && (
            <button type="button" role="menuitem" className={cn(MENU_ITEM_CLASS_NAME, "text-destructive")}
              onClick={() => { setOpen(null); onRecall(); }}>
              <Trash2 className="size-3.5 shrink-0" />
              <span className="flex-1">Recall</span>
            </button>
          )}
        </PaperPopover>
      )}
    </div>
  );
}

"use client";

import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/** What + makes: a conversation, a page, an Agent. `active` while what it made is still a draft;
    `shortcut` when Ctrl/⌘+N does the same, so the row shows it. */
export type CreateAction = { label: string; onCreate: () => void; disabled?: boolean; active?: boolean;
  shortcut?: boolean };

/** Ctrl/⌘+N makes what the open list shows. */
export function newShortcutLabel() {
  return typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘N" : "Ctrl+N";
}

/** A desktop list's +: the list's first row, set apart by its tone. Its +,
    label and Ctrl/⌘+N sit centred in a quieter ink than the rows' names, so it
    reads as the list's action rather than its first item. It stays lit while
    the new item is a draft. */
export function ListCreate({ action }: { action: CreateAction | null }) {
  if (!action) return null;
  const shortcut = action.shortcut ? newShortcutLabel() : null;
  return (
    <button type="button" title={shortcut ? `${action.label} (${shortcut})` : action.label} aria-label={action.label}
      disabled={action.disabled} onClick={action.onCreate}
      className={cn("app-list-create app-list-row hidden items-center justify-center disabled:opacity-40 md:flex",
        action.active && "app-list-create-active")}>
      <span className="app-list-create-mark flex shrink-0 items-center justify-center"><Plus /></span>
      <span className="app-list-row-title min-w-0 truncate">{action.label}</span>
      {shortcut && <kbd className="app-list-create-shortcut shrink-0" aria-hidden>{shortcut}</kbd>}
    </button>
  );
}

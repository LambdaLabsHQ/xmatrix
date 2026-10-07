"use client";

import { Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** What + makes: a conversation, a page, an Agent. `active` while what it made is still a draft. */
export type CreateAction = { label: string; onCreate: () => void; disabled?: boolean; active?: boolean };

/** Ctrl/⌘+N makes what the open list shows. */
export function newShortcutLabel() {
  return typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘N" : "Ctrl+N";
}

/** A desktop list's +: the list's first row, set apart by its tone. The + sits
    in the rows' leading slot and the label where their names start, in their
    type. It stays lit while the new item is a draft. */
export function ListCreate({ action, lead }: {
  action: CreateAction | null;
  /** The rows' leading mark, when it is an avatar rather than an icon. */
  lead?: "avatar";
}) {
  if (!action) return null;
  return (
    <button type="button" title={`${action.label} (${newShortcutLabel()})`} aria-label={action.label}
      disabled={action.disabled} onClick={action.onCreate} data-lead={lead}
      className={cn("app-list-create app-list-row hidden items-center text-left disabled:opacity-40 md:flex",
        action.active && "app-list-create-active")}>
      <span className="app-list-create-mark flex shrink-0 items-center justify-center"><Plus /></span>
      <span className="app-list-row-title min-w-0 truncate">{action.label}</span>
    </button>
  );
}

/** Search's resting place on a desktop: the row above the list's +, in the same
    geometry and tone, so it is always where the list starts. ⌘F opens it too. */
export function ListSearch({ onSearch, active }: { onSearch?: () => void; active?: boolean }) {
  if (!onSearch) return null;
  return (
    <button type="button" title={`Search (${searchShortcutLabel()})`} aria-label="Search" onClick={onSearch}
      className={cn("app-list-create app-list-search app-list-row hidden items-center text-left md:flex",
        active && "app-list-create-active")}>
      <span className="app-list-create-mark flex shrink-0 items-center justify-center"><Search /></span>
      <span className="app-list-row-title min-w-0 truncate">Search</span>
    </button>
  );
}

function searchShortcutLabel() {
  return typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘F" : "Ctrl+F";
}

"use client";

import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * One tree row's frame: the padding, selected material and expand control.
 * The caller supplies the row's own label control as children. The row is a list row, two lines
 * as tall as a conversation or an agent, on a phone as beside a page.
 */
export function PageTreeRow({ depth, selected, open, onToggle, expandHidden, children }: {
  depth: number; selected: boolean; open: boolean; onToggle: () => void;
  expandHidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`app-page-row app-list-row group flex min-h-8 items-center gap-1${selected
      ? " app-page-row-selected font-semibold" : ""}`}
      style={{ "--page-depth": depth } as CSSProperties}>
      <button type="button" aria-label={open ? "Collapse" : "Expand"}
        className={`flex size-5 shrink-0 items-center justify-center text-muted-foreground ${expandHidden ? "invisible" : ""}`}
        onClick={onToggle}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </button>
      {children}
    </div>
  );
}

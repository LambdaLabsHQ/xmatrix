"use client";

import type { ComponentType, SVGProps } from "react";

import { tagClass } from "./status-tag";

/** What a marked section is: one waiting on the reader, the reader's pins, or the rest by time. */
export type ListSectionTone = "attention" | "pinned" | "recent";

/**
 * A list's section: its name over its rows, in a tool list's section label
 * (ToolListGroup), starting where the rows' content does, with a count or
 * one action at its end. A section with a mark wears its name as a paper
 * label in the mark's tone, its count inside the label.
 */
export function ListSectionHeading({ label, count, action, mark }: {
  label: string;
  count?: number;
  action?: { label: string; onClick: () => void };
  mark?: { icon: ComponentType<Pick<SVGProps<SVGSVGElement>, "className">>; tone: ListSectionTone };
}) {
  const Icon = mark?.icon;
  return (
    <div className="app-list-section-heading flex min-w-0 items-end gap-1.5 pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] text-xs font-bold text-muted-foreground">
      {mark && Icon ? (
        <h2 className={tagClass("app-list-section-label min-w-0")} data-tone={mark.tone}>
          <Icon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          {count !== undefined && <span className="tabular-nums">{count}</span>}
        </h2>
      ) : (
        <>
          <h2 className="min-w-0 truncate">{label}</h2>
          {count !== undefined && <span className="ml-auto pl-2 font-medium tabular-nums">{count}</span>}
        </>
      )}
      {action && (
        <button type="button" className="app-list-section-action ml-auto pl-2 font-medium hover:text-foreground"
          onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

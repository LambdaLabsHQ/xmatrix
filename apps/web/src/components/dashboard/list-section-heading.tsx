"use client";

import type { ComponentType, SVGProps } from "react";
import { Clock } from "lucide-react";

import { tagClass } from "./status-tag";

/** A section's ink: brass for what waits on the reader, blue for the list's own main set, plain for the rest. */
export type ListSectionTone = "attention" | "primary" | "plain";
export type ListSectionMark = { icon: ComponentType<Pick<SVGProps<SVGSVGElement>, "className">>; tone: ListSectionTone };

/** The conversation list's own section, and what its skeleton stands under. */
export const RECENT_SECTION: { label: string; mark: ListSectionMark } = { label: "Recent", mark: { icon: Clock, tone: "plain" } };

/**
 * A list's section: its name over its rows, starting where the rows' content
 * does, with one action at its end. The name is a paper label in the
 * section's tone, with its icon before it and its count inside it.
 */
export function ListSectionHeading({ label, count, action, mark }: {
  label: string;
  count?: number;
  /** `expanded` says the action folds the section's rows, and whether they show now. */
  action?: { label: string; onClick: () => void; expanded?: boolean };
  mark?: ListSectionMark;
}) {
  const Icon = mark?.icon;
  return (
    <div className="app-list-section-heading flex min-w-0 items-end gap-1.5 pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] text-xs font-bold text-muted-foreground">
      <h2 className={tagClass("app-list-section-label min-w-0")} data-tone={mark?.tone ?? "plain"}>
        {Icon && <Icon className="size-3 shrink-0" />}
        <span className="min-w-0 truncate">{label}</span>
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </h2>
      {action && (
        <button type="button" className="app-list-section-action ml-auto pl-2 font-medium hover:text-foreground"
          aria-expanded={action.expanded} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

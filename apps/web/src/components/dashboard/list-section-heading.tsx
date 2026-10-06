"use client";

/**
 * A list's section: its name over its rows, in a tool list's section label
 * (ToolListGroup), starting where the rows' content does, with a count or
 * one action at its end.
 */
export function ListSectionHeading({ label, count, action }: {
  label: string;
  count?: number;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="app-list-section-heading flex min-w-0 items-end gap-1.5 pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] text-xs font-bold text-muted-foreground">
      <h2 className="min-w-0 truncate">{label}</h2>
      {count !== undefined && <span className="ml-auto pl-2 font-medium tabular-nums">{count}</span>}
      {action && (
        <button type="button" className="app-list-section-action ml-auto pl-2 font-medium hover:text-foreground"
          onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

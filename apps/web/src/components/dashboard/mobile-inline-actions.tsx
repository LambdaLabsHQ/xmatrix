"use client";

import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type MobileInlineAction = {
  key: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  destructive?: boolean;
  pressed?: boolean;
  onSelect: () => void;
};

/**
 * A phone's actions for one item, as a row of side-by-side options that opens
 * directly under the item that was tapped. The item stays in view and in
 * place, so what the actions act on is never in doubt, and nothing covers the
 * rest of the list the way a sheet does.
 */
export function MobileInlineActions({
  label,
  actions,
  className,
  children,
}: {
  label: string;
  actions: MobileInlineAction[];
  className?: string;
  /** Rendered above the options, e.g. a quick-reaction row. */
  children?: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-mobile-inline-actions="true"
      className={cn("app-mobile-inline-actions", className)}
    >
      {children}
      <div className="app-mobile-inline-actions-row">
        {actions.map(({ key, icon: Icon, label: actionLabel, destructive, pressed, onSelect }) => (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            data-destructive={destructive || undefined}
            className="app-mobile-inline-action"
            onClick={onSelect}
          >
            <Icon className="size-[1.125rem] shrink-0" />
            <span>{actionLabel}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

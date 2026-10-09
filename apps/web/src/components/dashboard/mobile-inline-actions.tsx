"use client";

import { useState, type ComponentType, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export type MobileInlineAction = {
  key: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  destructive?: boolean;
  pressed?: boolean;
  /** Ask in place: the first tap turns the option into "Confirm", the second selects it. */
  confirm?: boolean;
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
  const [armedKey, setArmedKey] = useState<string | null>(null);
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-mobile-inline-actions="true"
      className={cn("app-mobile-inline-actions", className)}
    >
      {children}
      <div className="app-mobile-inline-actions-row">
        {actions.map(({ key, icon: Icon, label: actionLabel, destructive, pressed, confirm, onSelect }) => {
          const armed = armedKey === key;
          return (
            <button
              key={key}
              type="button"
              aria-label={armed ? `Confirm ${actionLabel.toLowerCase()}` : undefined}
              aria-pressed={pressed}
              data-destructive={destructive || undefined}
              data-armed={armed || undefined}
              className="app-mobile-inline-action"
              onClick={() => {
                if (confirm && !armed) {
                  setArmedKey(key);
                  return;
                }
                setArmedKey(null);
                onSelect();
              }}
            >
              <Icon className="size-[1.125rem] shrink-0" />
              <span>{armed ? "Confirm" : actionLabel}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Row primitives shared by every composer completion panel (mention, launch
 * target, slash command) so the panels cannot drift apart in keyboard role,
 * pointer handling, or selected-row styling.
 */

export function avatarInitials(value: string): string {
  const initials = value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  return initials || "XM";
}

export function stopTouchPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function preventMousePointerDefault(event: { pointerType: string; preventDefault: () => void }) {
  if (event.pointerType === "mouse") event.preventDefault();
}

export function CompletionOptionButton({
  optionRef,
  selected,
  disabled,
  onSelect,
  className,
  children,
}: {
  optionRef: (node: HTMLElement | null) => void;
  selected: boolean;
  /** Visible, but not a choice. Keyboard movement skips it. */
  disabled?: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      ref={optionRef}
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onPointerDown={preventMousePointerDefault}
      onClick={(event) => {
        event.preventDefault();
        if (disabled) return;
        onSelect();
      }}
      className={cn(
        "app-completion-option flex w-full items-center gap-2 px-2 py-1 text-left text-sm",
        disabled && "cursor-default opacity-45",
        className
      )}
    >
      {children}
    </button>
  );
}

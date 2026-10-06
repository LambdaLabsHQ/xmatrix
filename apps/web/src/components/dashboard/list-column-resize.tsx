"use client";

import {
  createContext,
  useContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  DESKTOP_SIDEBAR_MAX_WIDTH_PX,
  DESKTOP_SIDEBAR_MIN_WIDTH_PX,
} from "./workspace-shell-constants";

/** The conversation list's width, and the same drag the other list columns use. */
export type ListColumnResize = {
  width: number;
  resizing: boolean;
  startResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
};

const ListColumnResizeContext = createContext<ListColumnResize | null>(null);

export function ListColumnResizeProvider({
  value,
  children,
}: {
  value: ListColumnResize;
  children: ReactNode;
}) {
  return <ListColumnResizeContext.Provider value={value}>{children}</ListColumnResizeContext.Provider>;
}

/**
 * The invisible grip between a list column and what it opens. Chat, Pages and
 * every rail destination that has its own list share this control and the one
 * stored width.
 */
export function ListColumnResizeHandle({ className }: { className?: string }) {
  const resize = useContext(ListColumnResizeContext);
  if (!resize) return null;
  return (
    <button
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={DESKTOP_SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={DESKTOP_SIDEBAR_MAX_WIDTH_PX}
      aria-valuenow={resize.width}
      title="Resize sidebar"
      className={cn(
        "app-sidebar-resize-handle relative z-30 -mx-2 hidden w-4 shrink-0 cursor-col-resize touch-none border-0 bg-transparent p-0 shadow-none",
        "focus-visible:bg-primary/15 focus-visible:outline-none",
        resize.resizing && "bg-primary/10",
        className,
      )}
      onPointerDown={resize.startResize}
      onKeyDown={resize.onKeyDown}
    />
  );
}

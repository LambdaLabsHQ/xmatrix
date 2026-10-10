"use client";

import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * One tree row's frame: the padding, selected material and expand control.
 * The caller supplies the row's own label control as children. The row is a list row, two lines
 * as tall as a conversation or an agent, on a phone as beside a page.
 */
/** How long a finger rests on a row before its actions open, and how far it may drift: a conversation row's values. */
const LONG_PRESS_MS = 420;
const LONG_PRESS_DRIFT_PX = 10;

/**
 * A touch that rests on a row opens its actions, as on a conversation row; a
 * mouse has hover and the row's own controls instead. The tap that ends a long
 * press does not also open the page.
 */
function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  if (!onLongPress) return {};
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      clear();
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        clear();
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const from = origin.current;
      if (from && (Math.abs(event.clientX - from.x) > LONG_PRESS_DRIFT_PX
        || Math.abs(event.clientY - from.y) > LONG_PRESS_DRIFT_PX)) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
  };
}

export function PageTreeRow({ depth, selected, open, onToggle, expandHidden, onLongPress, children }: {
  depth: number; selected: boolean; open: boolean; onToggle: () => void;
  expandHidden?: boolean;
  /** Opens the row's actions; only a touch long-presses. */
  onLongPress?: () => void;
  children: ReactNode;
}) {
  const press = useLongPress(onLongPress);
  return (
    <div className={`app-page-row app-list-row group flex min-h-8 items-center gap-1${selected
      ? " app-page-row-selected font-semibold" : ""}`}
      style={{ "--page-depth": depth } as CSSProperties} {...press}>
      <button type="button" aria-label={open ? "Collapse" : "Expand"}
        className={`flex size-5 shrink-0 items-center justify-center text-muted-foreground ${expandHidden ? "invisible" : ""}`}
        onClick={onToggle}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </button>
      {children}
    </div>
  );
}

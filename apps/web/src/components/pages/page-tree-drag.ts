"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { pageDropAt, type PageDrop, type PageDropEdge, type PagePlaceInput } from "./page-tree-move";

const DRAG_PX = 8;

/** The row whose edge shows where the page will land. A drop below a page with open children lands after them. */
export interface PageDragHint {
  lineId: string;
  edge: PageDropEdge;
}

function lineFor(row: HTMLElement, edge: PageDropEdge): HTMLElement {
  if (edge === "above") return row;
  const nested = row.closest("li")?.querySelector(":scope > ul");
  const rows = nested?.querySelectorAll(".app-page-row");
  const last = rows?.[rows.length - 1];
  return last instanceof HTMLElement ? last : row;
}

/**
 * Drag a page row with the mouse and drop it on the top or bottom half of another.
 * A touch still scrolls and long-presses; capturing it would take the list's scroll.
 */
export function usePageRowDrag(pages: readonly PagePlaceInput[], onDrop: (pageId: string, drop: PageDrop) => void) {
  const [hint, setHint] = useState<PageDragHint | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const gesture = useRef<{ pointerId: number; pageId: string; x: number; y: number; dragged: boolean } | null>(null);
  const suppressClick = useRef(false);

  const placeAt = (pageId: string, x: number, y: number): PageDrop | null => {
    const row = document.elementsFromPoint(x, y)
      .map((node) => node instanceof Element ? node.closest<HTMLElement>("[data-page-id]") : null)
      .find((node) => node && node.dataset.pageId && node.dataset.pageId !== pageId) ?? null;
    const targetId = row?.dataset.pageId;
    if (!row || !targetId) {
      setHint((current) => current === null ? current : null);
      return null;
    }
    const rect = row.getBoundingClientRect();
    const edge: PageDropEdge = y < rect.top + rect.height / 2 ? "above" : "below";
    const drop = pageDropAt(pages, pageId, targetId, edge);
    if (!drop) {
      setHint((current) => current === null ? current : null);
      return null;
    }
    const line = lineFor(row, edge);
    const lineId = line.dataset.pageId ?? targetId;
    setHint((current) => current?.lineId === lineId && current.edge === edge ? current : { lineId, edge });
    return drop;
  };

  const end = () => {
    gesture.current = null;
    setDraggingId(null);
    setHint(null);
  };

  const bind = (pageId: string, enabled: boolean) => {
    if (!enabled) return {};
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || event.pointerType === "touch" || !event.isPrimary) return;
        gesture.current = { pointerId: event.pointerId, pageId, x: event.clientX, y: event.clientY, dragged: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!current.dragged) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_PX) return;
          current.dragged = true;
          setDraggingId(current.pageId);
        }
        placeAt(current.pageId, event.clientX, event.clientY);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (current.dragged) {
          suppressClick.current = true;
          const drop = placeAt(current.pageId, event.clientX, event.clientY);
          if (drop) onDrop(current.pageId, drop);
        }
        end();
      },
      onPointerCancel: end,
      onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  };

  return { hint, draggingId, bind };
}

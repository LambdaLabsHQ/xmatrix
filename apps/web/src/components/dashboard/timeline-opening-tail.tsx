"use client";

import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* A conversation opens on its last screen of messages, drawn here as plain
   rows in the commit that opens it. The virtual list cannot do that: landing
   on its last row takes it four frames, a scroll, a render of the rows there
   and a 150ms settle, and it keeps its rows hidden until then, so a channel
   opened onto an empty timeline for a quarter of a second and then filled in
   one frame. While the tail is up the list lands on blank rows of the heights
   measured here, then takes over in place: its rows sit exactly where these
   were, so nothing moves.

   The rows are rendered once. Each lives in a node of its own (its host),
   which the tail holds first and the list's item adopts when it takes over,
   so a row keeps its DOM and its state across the handover. */

/** Where one row's host sits: in the tail, then in the virtual list's item. */
export function TimelineRowSlot({ host, ...attributes }: { host: HTMLElement } & HTMLAttributes<HTMLDivElement>) {
  const adopt = useCallback((slot: HTMLDivElement | null) => {
    if (!slot || host.parentElement === slot) return;
    // A move keeps the row's focus, selection and running animations; where
    // the browser has none, or the host is not in the page yet, it is appended.
    const movable = slot as HTMLDivElement & { moveBefore?: (node: Node, before: Node | null) => void };
    if (movable.moveBefore && host.isConnected && slot.isConnected) movable.moveBefore(host, null);
    else slot.appendChild(host);
  }, [host]);
  return <div ref={adopt} {...attributes} />;
}

/** What the tail measured, for the virtual list to land on. */
export interface TimelineOpeningMeasure {
  rowHeights: ReadonlyMap<string, number>;
  headerHeight: number;
  /** How many of the tail's rows, counted from the last, were on screen. */
  screenRows: number;
}

/** A row the tail drew; its id keys the height the virtual list lands on. */
export const TIMELINE_OPENING_ROW_ATTRIBUTE = "data-timeline-opening-row";

const VIRTUAL_ITEM_LIST = "[data-testid='virtuoso-item-list']";

export function TimelineOpeningTail({ scrollRoot, complete, header, footerClassName, children, onMeasured, onLanded }: {
  scrollRoot: HTMLElement;
  /** Every row of the window is drawn, so the content starts at its top like the list's. */
  complete: boolean;
  header: ReactNode;
  footerClassName: string;
  children: ReactNode;
  onMeasured: (measure: TimelineOpeningMeasure) => void;
  /** The virtual list shows its rows at the bottom. */
  onLanded: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const footer = footerRef.current;
    const list = scrollRoot.querySelector<HTMLElement>(VIRTUAL_ITEM_LIST);
    if (!viewport || !content || !footer || !list) {
      onLanded();
      return;
    }
    const viewportHeight = scrollRoot.clientHeight;
    viewport.style.height = `${viewportHeight}px`;

    // A row's height is the distance to the next one, so margins between rows count.
    const rows = Array.from(content.querySelectorAll<HTMLElement>(`:scope > [${TIMELINE_OPENING_ROW_ATTRIBUTE}]`));
    const tops = [...rows, footer].map((element) => element.getBoundingClientRect().top);
    const rowHeights = new Map<string, number>();
    rows.forEach((row, index) => {
      rowHeights.set(row.getAttribute(TIMELINE_OPENING_ROW_ATTRIBUTE) ?? "", tops[index + 1]! - tops[index]!);
    });
    // How many rows, counted from the last, it took to fill the screen.
    let screenRows = 0;
    for (let filled = tops[rows.length]! - tops[0]!, index = 0; index < rows.length; index += 1) {
      screenRows = rows.length - index;
      filled -= rowHeights.get(rows[index]!.getAttribute(TIMELINE_OPENING_ROW_ATTRIBUTE) ?? "") ?? 0;
      if (filled < viewportHeight) break;
    }
    onMeasured({
      rowHeights,
      headerHeight: headerRef.current?.getBoundingClientRect().height ?? 0,
      screenRows,
    });

    // The list hides its rows until it has landed on the last one.
    let hidden = list.style.visibility === "hidden";
    const observer = new MutationObserver(() => {
      if (list.style.visibility === "hidden") {
        hidden = true;
        return;
      }
      if (!hidden || list.childElementCount === 0) return;
      observer.disconnect();
      onLanded();
    });
    observer.observe(list, { attributes: true, attributeFilter: ["style"] });
    // The composer and the bars around the timeline settle after it mounts.
    const resize = new ResizeObserver(() => {
      viewport.style.height = `${scrollRoot.clientHeight}px`;
    });
    resize.observe(scrollRoot);
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
  }, [onLanded, onMeasured, scrollRoot]);

  return (
    // Not a div: the stylesheet pads the scroll root's div children, and the
    // virtual list draws over that padding, so the tail must not have it.
    <section className="app-message-timeline-opening-tail sticky top-0 z-[1] block h-0">
      <div ref={viewportRef} className="absolute inset-x-0 top-0 flex flex-col justify-end overflow-hidden">
        <div ref={contentRef} className={cn("shrink-0", complete && "min-h-full")}>
          {complete && <div ref={headerRef}>{header}</div>}
          {children}
          <div ref={footerRef} className={footerClassName} />
        </div>
      </div>
    </section>
  );
}

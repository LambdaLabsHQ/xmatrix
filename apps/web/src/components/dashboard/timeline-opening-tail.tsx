"use client";

import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/* A conversation opens on its last screen of messages, drawn here as plain
   rows in the commit that opens it. The virtual list cannot do that: landing
   on its last row takes it four frames, a scroll, a render of the rows there
   and a 150ms settle, and it keeps its rows hidden until then, so a channel
   opened onto an empty timeline for a quarter of a second and then filled in
   one frame.

   While the tail is up the list works behind it, unseen, in two steps. It
   lands on blank rows of the heights measured here. Then it renders the rows
   it will show around them and measures those, because a row it first draws
   at the handover has only an estimated height, and the list moves every row
   by the error for a frame before its total height follows. Once a frame has
   passed in which nothing in the list changed size, and the blanks are as
   tall as the rows here are now, the list takes over in place: its rows sit
   exactly where these were, so nothing moves.

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

/** Heights differ by a rounding of the same layout, not by a row that grew. */
const SAME_HEIGHT_PX = 0.5;
/* Settling takes the list a few frames. One whose rows never stop changing
   size takes over as it is after this long: the tail does not scroll, and a
   jump to a message waits for the list. */
const SETTLE_WITHIN_MS = 1_000;

function sameOpeningMeasure(left: TimelineOpeningMeasure, right: TimelineOpeningMeasure): boolean {
  if (left.rowHeights.size !== right.rowHeights.size) return false;
  if (Math.abs(left.headerHeight - right.headerHeight) > SAME_HEIGHT_PX) return false;
  for (const [rowId, height] of left.rowHeights) {
    const other = right.rowHeights.get(rowId);
    if (other === undefined || Math.abs(other - height) > SAME_HEIGHT_PX) return false;
  }
  return true;
}

export function TimelineOpeningTail({ scrollRoot, complete, header, footerClassName, children, onMeasured, onListLanded, onSettled }: {
  scrollRoot: HTMLElement;
  /** Every row of the window is drawn, so the content starts at its top like the list's. */
  complete: boolean;
  header: ReactNode;
  footerClassName: string;
  children: ReactNode;
  /** The heights of the rows drawn here, again whenever one of them changes. */
  onMeasured: (measure: TimelineOpeningMeasure) => void;
  /** The virtual list has landed on its last row; it can render its own rows now. */
  onListLanded: () => void;
  /** The list's rows are where the tail's are and no longer change size. */
  onSettled: () => void;
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
      onSettled();
      return;
    }
    viewport.style.height = `${scrollRoot.clientHeight}px`;

    const measure = (): TimelineOpeningMeasure => {
      // A row's height is the distance to the next one, so margins between rows count.
      const rows = Array.from(content.querySelectorAll<HTMLElement>(`:scope > [${TIMELINE_OPENING_ROW_ATTRIBUTE}]`));
      const tops = [...rows, footer].map((element) => element.getBoundingClientRect().top);
      const rowHeights = new Map<string, number>();
      rows.forEach((row, index) => {
        rowHeights.set(row.getAttribute(TIMELINE_OPENING_ROW_ATTRIBUTE) ?? "", tops[index + 1]! - tops[index]!);
      });
      // How many rows, counted from the last, it took to fill the screen.
      const viewportHeight = scrollRoot.clientHeight;
      let screenRows = 0;
      for (let filled = tops[rows.length]! - tops[0]!, index = 0; index < rows.length; index += 1) {
        screenRows = rows.length - index;
        filled -= rowHeights.get(rows[index]!.getAttribute(TIMELINE_OPENING_ROW_ATTRIBUTE) ?? "") ?? 0;
        if (filled < viewportHeight) break;
      }
      return { rowHeights, headerHeight: headerRef.current?.getBoundingClientRect().height ?? 0, screenRows };
    };
    let measured = measure();
    onMeasured(measured);
    /** Says so when a row here is no longer the height the list was told. */
    const measureAgain = (): boolean => {
      const current = measure();
      if (sameOpeningMeasure(measured, current)) return false;
      measured = current;
      onMeasured(current);
      return true;
    };

    /* The list has settled once a whole frame passes in which nothing it lays
       out changed. Its measurements reach the page a task after it takes
       them, so what it laid out is read again when the frame is over: a
       change that has not been observed yet still holds the handover back. */
    let landed = false;
    let settleBy = 0;
    let quietFrame = 0;
    const listLayout = () =>
      `${scrollRoot.scrollHeight}:${scrollRoot.scrollTop}:${list.offsetHeight}:${list.style.paddingTop}`;
    const awaitQuietFrame = () => {
      if (!landed) return;
      cancelAnimationFrame(quietFrame);
      const armed = listLayout();
      quietFrame = requestAnimationFrame(() => {
        if (performance.now() > settleBy) {
          onSettled();
          return;
        }
        quietFrame = requestAnimationFrame(() => {
          if (measureAgain() || listLayout() !== armed) awaitQuietFrame();
          else onSettled();
        });
      });
    };
    const sizes = new ResizeObserver(() => {
      // A row here that grew is a blank the list has to grow as well.
      measureAgain();
      awaitQuietFrame();
    });
    // Border boxes: a row the list swaps for spacing changes its padding only.
    for (const element of [content, list, list.parentElement]) {
      if (element) sizes.observe(element, { box: "border-box" });
    }
    scrollRoot.addEventListener("scroll", awaitQuietFrame, { passive: true });

    // The list hides its rows until it has landed on the last one.
    let hidden = list.style.visibility === "hidden";
    const landing = new MutationObserver(() => {
      if (list.style.visibility === "hidden") {
        hidden = true;
        return;
      }
      if (!hidden || list.childElementCount === 0) return;
      landing.disconnect();
      landed = true;
      settleBy = performance.now() + SETTLE_WITHIN_MS;
      onListLanded();
      awaitQuietFrame();
    });
    landing.observe(list, { attributes: true, attributeFilter: ["style"] });
    // The composer and the bars around the timeline settle after it mounts.
    const resize = new ResizeObserver(() => {
      viewport.style.height = `${scrollRoot.clientHeight}px`;
    });
    resize.observe(scrollRoot);
    return () => {
      cancelAnimationFrame(quietFrame);
      scrollRoot.removeEventListener("scroll", awaitQuietFrame);
      landing.disconnect();
      sizes.disconnect();
      resize.disconnect();
    };
  }, [onListLanded, onMeasured, onSettled, scrollRoot]);

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

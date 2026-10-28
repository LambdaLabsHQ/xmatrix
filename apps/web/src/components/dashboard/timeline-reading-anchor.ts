"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { SCROLLING_MOVES_NO_ROWS } from "./timeline-scroll-rest";

/* The message a reader is looking at while an older page is prepended above
   it, and where on screen its content sat before the prepend.

   The virtualizer's own prepend compensation keeps rows in place relative to
   its list, but not against everything else that moves in the same commit:
   the header above the list (the older-history loader disappears on the last
   page) and the old first row itself (it loses its day divider once a
   same-day predecessor arrives). Rows the virtualizer renders above while the
   reader keeps scrolling shift the view again until it measures them. This
   anchor pins the text. */
interface ReadingAnchor {
  rowId: string;
  offset: number;
}

/* A settled prepend stops being corrected after this long without activity, so
   later growth (a new message, a late image) behaves like any other layout. */
const READING_ANCHOR_SETTLE_MS = 750;
/* Passive layout drift cannot keep an anchor alive indefinitely. Further
   reader input renews this bounded window, so it cannot expire mid-scroll on
   a slow renderer. The quiet timer still releases an ordinarily settled page. */
const READING_ANCHOR_MAX_MS = 10_000;

/* The row wrapper carries the anchor id; its last child is the message row
   itself, below any day divider the wrapper also renders. */
function readingAnchorContent(root: HTMLElement, rowId: string): HTMLElement | null {
  const row = root.ownerDocument.getElementById(rowId);
  if (!row || !root.contains(row)) return null;
  return (row.lastElementChild as HTMLElement | null) ?? row;
}

function captureReadingAnchor(root: HTMLElement): ReadingAnchor | null {
  const rootTop = root.getBoundingClientRect().top;
  for (const row of root.querySelectorAll<HTMLElement>("[id^='message:']")) {
    const content = (row.lastElementChild as HTMLElement | null) ?? row;
    const rect = content.getBoundingClientRect();
    if (rect.bottom <= rootTop) continue;
    return { rowId: row.id, offset: rect.top - rootTop };
  }
  return null;
}

/* Everything whose size places the timeline's rows. Border boxes, three layout
   levels down: the virtualizer's scroller, its viewport, and the header, list,
   and footer inside its visual layer. That layer does not consume a level.
   A list padding change (rows swapped for spacer) moves the rows without
   changing any content box. */
export function observeTimelineBoxes(root: Element, observer: ResizeObserver, depth = 3) {
  for (const child of root.children) {
    observer.observe(child, { box: "border-box" });
    const remaining = child.hasAttribute("data-timeline-rise-content") ? depth : depth - 1;
    if (remaining > 0) observeTimelineBoxes(child, observer, remaining);
  }
}

/**
 * Keeps the reader's message fixed on screen across a history prepend.
 *
 * `snapshot` must be called while the DOM still shows the pre-prepend layout
 * (during render). `apply` is called from the commit's layout effect; from
 * then on every resize of the timeline content is followed, before paint, by a
 * scroll correction that puts the anchor back, while the reader's own
 * scrolling moves where it is held. An explicit jump, a channel switch, or a
 * quiet period releases it.
 */
export function useTimelineReadingAnchor(root: HTMLElement | null) {
  const pendingRef = useRef<{ key: unknown; anchor: ReadingAnchor } | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const snapshot = useCallback((key: unknown) => {
    if (!root) return;
    if (pendingRef.current?.key === key) return;
    const anchor = captureReadingAnchor(root);
    pendingRef.current = anchor ? { key, anchor } : null;
  }, [root]);

  const apply = useCallback((key: unknown) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!root || !pending || pending.key !== key) return;
    release();

    const { rowId } = pending.anchor;
    let { offset } = pending.anchor;
    const startedAt = performance.now();
    let lastActivityAt = startedAt;
    let lastInputAt = startedAt;
    let corrected = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const anchorTop = (): number | null => {
      const content = readingAnchorContent(root, rowId);
      return content ? content.getBoundingClientRect().top - root.getBoundingClientRect().top : null;
    };

    /* Where the timeline was scrolled when the anchor was last known to be in
       place. A scroll event's difference from it is the reader's own movement
       since the last frame; anything else the anchor moved is drift. */
    let heldScrollTop = root.scrollTop;
    const hold = (top: number, expected: number) => {
      const drift = top - expected;
      offset = expected;
      if (Math.abs(drift) >= 0.5) {
        root.scrollTop += drift;
        lastActivityAt = performance.now();
      }
      heldScrollTop = root.scrollTop;
    };

    // Input can move the scroller before its queued scroll event is delivered.
    // A layout correction in that gap must credit the reader's movement first.
    let inputScrollTop: number | null = null;
    const followInput = () => {
      if (inputScrollTop === null) return;
      offset -= root.scrollTop - inputScrollTop;
      inputScrollTop = null;
      heldScrollTop = root.scrollTop;
    };
    const onInput = (event: Event) => {
      if (event.type === "pointermove" && (event as PointerEvent).buttons === 0) return;
      if (SCROLLING_MOVES_NO_ROWS) {
        release();
        return;
      }
      followInput();
      inputScrollTop = root.scrollTop;
      lastActivityAt = performance.now();
      lastInputAt = lastActivityAt;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(release, READING_ANCHOR_MAX_MS);
    };

    /* ResizeObserver callbacks run after layout and before paint, and after
       the virtualizer's own animation-frame scroll adjustments, so the
       correction always has the last word in the frame the reader sees. */
    const correctLayout = () => {
      if (performance.now() - lastInputAt > READING_ANCHOR_MAX_MS) {
        release();
        return;
      }
      const top = anchorTop();
      if (top === null) {
        release();
        return;
      }
      // Stable text can still be followed by another slow virtualizer measure.
      // Release only after the layout and the reader have both gone quiet.
      lastActivityAt = performance.now();
      followInput();
      corrected = true;
      hold(top, offset);
    };
    const observer = new ResizeObserver(correctLayout);
    observeTimelineBoxes(root, observer);
    const row = root.ownerDocument.getElementById(rowId);
    if (row && root.contains(row)) observer.observe(row, { box: "border-box" });
    // A virtualizer margin or padding swap can move the text without changing
    // any observed border box. Follow that commit before its next paint too.
    const mutations = new MutationObserver(correctLayout);
    mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });

    /* The reader keeps scrolling while the page settles. Their scroll moves
       the anchor on purpose, so the held place follows it; the virtualizer
       may re-render rows above in the same event, which is drift. Only after
       the first correction: until then the layout still carries the drift the
       prepend introduced. */
    const onScroll = () => {
      // The anchor's own correction leaves the timeline where it was held.
      // Where a scroll mid-flick blanks the screen, the anchor holds only
      // until someone else scrolls (see timeline-scroll-rest).
      if (SCROLLING_MOVES_NO_ROWS && root.scrollTop !== heldScrollTop) {
        release();
        return;
      }
      if (root.scrollTop !== heldScrollTop) lastActivityAt = performance.now();
      if (!corrected) return;
      followInput();
      const top = anchorTop();
      if (top === null) {
        release();
        return;
      }
      hold(top, offset - (root.scrollTop - heldScrollTop));
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    const inputEvents = ["wheel", "touchmove", "keydown", "pointermove"] as const;
    for (const event of inputEvents) root.addEventListener(event, onInput, { passive: true });

    const scheduleSettle = () => {
      const idle = performance.now() - lastActivityAt;
      settleTimer = setTimeout(() => {
        if (performance.now() - lastActivityAt >= READING_ANCHOR_SETTLE_MS) release();
        else scheduleSettle();
      }, Math.max(0, READING_ANCHOR_SETTLE_MS - idle));
    };
    scheduleSettle();
    // Only reader input renews this deadline, never passive scroll corrections.
    deadlineTimer = setTimeout(release, READING_ANCHOR_MAX_MS);

    releaseRef.current = () => {
      observer.disconnect();
      mutations.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      root.removeEventListener("scroll", onScroll);
      for (const event of inputEvents) root.removeEventListener(event, onInput);
    };
  }, [release, root]);

  useEffect(() => release, [release, root]);

  return useMemo(() => ({ snapshot, apply, release }), [apply, release, snapshot]);
}

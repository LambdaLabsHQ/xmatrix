"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

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

/* A settled prepend stops being corrected after this long without drift, so
   later growth (a new message, a late image) behaves like any other layout. */
const READING_ANCHOR_SETTLE_MS = 750;
/* Hard ceiling for a continuously changing prepend. Slow renderers can take
   more than three seconds to finish the virtualizer's measurements and final
   scroll compensation. Keep that correction window open; the much shorter
   quiet-period timer still releases an ordinarily settled prepend. */
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
    let lastDriftAt = startedAt;
    let corrected = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

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
        lastDriftAt = performance.now();
      }
      heldScrollTop = root.scrollTop;
    };

    /* ResizeObserver callbacks run after layout and before paint, and after
       the virtualizer's own animation-frame scroll adjustments, so the
       correction always has the last word in the frame the reader sees. */
    const observer = new ResizeObserver(() => {
      if (performance.now() - startedAt > READING_ANCHOR_MAX_MS) {
        release();
        return;
      }
      const top = anchorTop();
      if (top === null) {
        release();
        return;
      }
      corrected = true;
      hold(top, offset);
    });
    /* Border boxes, three levels down: the virtualizer's scroller, its
       viewport, and the header, list, and footer inside it. A list padding
       change (rows swapped for spacer) moves the anchor without changing any
       content box. */
    const observeLevel = (parent: Element, depth: number) => {
      for (const child of parent.children) {
        observer.observe(child, { box: "border-box" });
        if (depth > 1) observeLevel(child, depth - 1);
      }
    };
    observeLevel(root, 3);
    const row = root.ownerDocument.getElementById(rowId);
    if (row && root.contains(row)) observer.observe(row, { box: "border-box" });

    /* The reader keeps scrolling while the page settles. Their scroll moves
       the anchor on purpose, so the held place follows it; the virtualizer
       may re-render rows above in the same event, which is drift. Only after
       the first correction: until then the layout still carries the drift the
       prepend introduced. */
    const onScroll = () => {
      if (!corrected) return;
      const top = anchorTop();
      if (top === null) {
        release();
        return;
      }
      hold(top, offset - (root.scrollTop - heldScrollTop));
    };
    root.addEventListener("scroll", onScroll, { passive: true });

    const scheduleSettle = () => {
      const idle = performance.now() - lastDriftAt;
      settleTimer = setTimeout(() => {
        if (performance.now() - lastDriftAt >= READING_ANCHOR_SETTLE_MS) release();
        else scheduleSettle();
      }, Math.max(0, READING_ANCHOR_SETTLE_MS - idle));
    };
    scheduleSettle();
    // Scroll corrections can keep the quiet timer busy without another resize.
    const deadlineTimer = setTimeout(release, READING_ANCHOR_MAX_MS);

    releaseRef.current = () => {
      observer.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
      clearTimeout(deadlineTimer);
      root.removeEventListener("scroll", onScroll);
    };
  }, [release, root]);

  useEffect(() => release, [release, root]);

  return useMemo(() => ({ snapshot, apply, release }), [apply, release, snapshot]);
}

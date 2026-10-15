/* On iPhone a scroll written while the reader's flick is still carrying the
   timeline stops it, and WebKit shows the place it lands on before painting
   it: a blank band across the messages with a line of text cut through
   (user 2026-10-14 and 2026-10-15, both while scrolling up).

   react-virtuoso knows this: there it holds its compensation for rows that
   change size in the list's margin and scrolls only once the reader stops
   (it uses this same UA test). An older page arriving is not held that way.
   Virtuoso keeps the reader's place across a prepend with a scroll, written
   in the next frame whether or not the reader is still scrolling. So on
   these devices an older page goes in once the timeline is at rest. */
export const SCROLLING_MOVES_NO_ROWS = typeof navigator !== "undefined" &&
  /iP(ad|od|hone)/i.test(navigator.userAgent) && /WebKit/i.test(navigator.userAgent);

/* WebKit reports a momentum scroll as scroll events every frame; a gap this
   long without one, with no finger down, is a timeline that has stopped. */
const SCROLL_REST_MS = 150;

/** Resolves once nothing has scrolled `root` for a while and no finger is on it. */
export function timelineScrollRest(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let touching = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = touching ? null : setTimeout(done, SCROLL_REST_MS);
    };
    const onTouchStart = () => {
      touching = true;
      arm();
    };
    const onTouchEnd = (event: TouchEvent) => {
      touching = event.touches.length > 0;
      arm();
    };
    const done = () => {
      root.removeEventListener("scroll", arm);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchEnd);
      resolve();
    };
    root.addEventListener("scroll", arm, { passive: true });
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    root.addEventListener("touchcancel", onTouchEnd, { passive: true });
    arm();
  });
}

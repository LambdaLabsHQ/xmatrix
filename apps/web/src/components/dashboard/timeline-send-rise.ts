import { observeTimelineBoxes } from "./timeline-reading-anchor";

/* Sending a message moves the timeline the way a chat app does: the new row
   rises out of the composer and the rows above it rise by the room it takes,
   instead of the whole list jumping in one frame. The scroll itself still
   lands at once; this only draws the way there, on the rows, so neither the
   virtualizer's measurements nor the scroll position are involved. */

const SEND_RISE_MS = 260;
const SEND_RISE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/* A short timeline has nothing to scroll, so its rows stay put and the new row
   alone rises this far. */
const SEND_RISE_MIN_PX = 24;
/* A row counts as just sent only this long after the send. The virtualizer
   mounts rows again as they scroll back into view, and a queued send can be
   restored much later; neither is a send the reader is watching. */
const SEND_RISE_FRESH_MS = 1_500;

export function isJustSentRow(message: { own?: boolean; sendStatus?: string; sentAt: string }): boolean {
  return Boolean(message.own) && message.sendStatus === "pending" &&
    Date.now() - Date.parse(message.sentAt) < SEND_RISE_FRESH_MS;
}

export function playTimelineSendRise(scrollRoot: HTMLElement, sentRow: HTMLElement) {
  if (
    typeof sentRow.animate !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }
  const rowHeight = sentRow.offsetHeight;
  // How far the pending scroll to the newest message will move the rows. A
  // reader who sent from further up is brought down by more than that; the
  // rows still rise by one row, not across the whole distance.
  const growth = Math.min(
    Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop),
    rowHeight,
  );
  const timing = { duration: SEND_RISE_MS, easing: SEND_RISE_EASING };
  if (growth >= 1) {
    for (const row of scrollRoot.querySelectorAll<HTMLElement>("[data-timeline-rise-row]")) {
      if (row === sentRow) continue;
      row.animate([{ transform: `translateY(${growth}px)` }, { transform: "none" }], timing);
    }
  }
  const sentRise = Math.max(growth, Math.min(rowHeight, SEND_RISE_MIN_PX));
  sentRow.animate(
    [
      { opacity: 0, transform: `translateY(${sentRise}px)` },
      { opacity: 1, offset: 0.6 },
      { opacity: 1, transform: "none" },
    ],
    timing,
  );
  followLaterMoves(scrollRoot, sentRow, timing);
}

/** One send is followed per timeline; the next one takes over. */
const followedSends = new WeakMap<HTMLElement, () => void>();

/* The row above is where the rise starts from, but the layout is not done
   moving when the row mounts. The composer gives back the lines of the draft
   a moment later and the timeline's end comes down with it, the list's height
   follows its rows by a frame, and the server's copy of the message can be
   laid out a little differently. Each of these moves every row at once, in
   one frame, in the middle of the rise.

   While the send is fresh, such a move is drawn as well: the rows go on from
   where they were to where they now belong. What is followed is how far the
   new row sits from the end of the timeline, which is where it stands on
   screen for a reader held at the newest message, and which the reader's own
   scrolling does not change. */
function followLaterMoves(scrollRoot: HTMLElement, sentRow: HTMLElement, timing: KeyframeAnimationOptions) {
  followedSends.get(scrollRoot)?.();
  // The row's place in the list: its own node is the one being drawn elsewhere.
  const place = sentRow.parentElement;
  if (!place || typeof KeyframeEffect === "undefined" || !("composite" in KeyframeEffect.prototype)) return;

  const fromEnd = () =>
    place.getBoundingClientRect().top - (scrollRoot.scrollHeight - scrollRoot.clientHeight - scrollRoot.scrollTop);
  let drawn = fromEnd();
  const follow = () => {
    if (!place.isConnected) {
      stop();
      return;
    }
    const now = fromEnd();
    const moved = now - drawn;
    if (Math.abs(moved) < 0.5) return;
    drawn = now;
    for (const row of scrollRoot.querySelectorAll<HTMLElement>("[data-timeline-rise-row]")) {
      // On top of the rise that is playing, from where the row was a moment ago.
      row.animate([{ transform: `translateY(${-moved}px)` }, { transform: "none" }], { ...timing, composite: "add" });
    }
  };

  /* A move reaches the page either in a task between two frames or while a
     frame lays out; it is followed before that frame is painted in both. */
  const until = performance.now() + SEND_RISE_FRESH_MS;
  let frame = requestAnimationFrame(function eachFrame() {
    follow();
    if (performance.now() > until) stop();
    else frame = requestAnimationFrame(eachFrame);
  });
  const sizes = new ResizeObserver(follow);
  observeTimelineBoxes(scrollRoot, sizes);
  function stop() {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    if (followedSends.get(scrollRoot) === stop) followedSends.delete(scrollRoot);
  }
  followedSends.set(scrollRoot, stop);
}

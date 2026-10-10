import { MESSAGE_SURFACE_METRICS_EVENT, messageSurfaceOf } from "./message-surface-metrics";
import { observeTimelineBoxes } from "./timeline-reading-anchor";

/* Sending a message moves the timeline the way a chat app does: the new row
   rises out of the composer and the rows above it rise by the room it takes,
   instead of the whole list jumping in one frame. The scroll itself still
   lands at once; this only draws the way there, on the rows, so neither the
   virtualizer's measurements nor the scroll position are involved.

   The layout does not get there in one step. The list first makes room for
   the new row by an estimate and corrects it a frame later, the composer
   gives back the lines of the draft, the server's copy can be laid out a
   little differently. Each step moves every row at once, some of them back
   down. So the rows are not sent along a path worked out when the row mounts:
   they are drawn where they were, and that distance from where the layout
   now has them only ever shrinks. However the layout arrives, the rows go
   one way and slow to a stop (user 2026-10-10: "没必要弹一下然后回来，就是逐渐速度减到 0"). */

const SEND_RISE_MS = 260;
/* The share of the distance left that goes in each millisecond: fast out of
   the composer, a hundredth of the way left when the rise is over. */
const SEND_RISE_PER_MS = Math.log(100) / SEND_RISE_MS;
const SEND_RISE_FRAME_MAX_MS = 34;
const SEND_RISE_QUIET_FRAMES = 1;
/* A short timeline has nothing to scroll, so its rows stay put and the new row
   alone rises this far. */
const SEND_RISE_MIN_PX = 24;
/* A row counts as just sent only this long after the send. The virtualizer
   mounts rows again as they scroll back into view, and a queued send can be
   restored much later; neither is a send the reader is watching. */
const SEND_RISE_FRESH_MS = 1_500;

/** Marks the elements that are as tall as the list's content (see their component). */
export const TIMELINE_HEIGHT_PROBE_ATTRIBUTE = "data-timeline-height-probe";

export function isJustSentRow(message: { own?: boolean; sendStatus?: string; sentAt: string }): boolean {
  return Boolean(message.own) && message.sendStatus === "pending" &&
    Date.now() - Date.parse(message.sentAt) < SEND_RISE_FRESH_MS;
}

/** The rise each timeline is playing: a layout move reported to it, and its end. */
const risingTimelines = new WeakMap<HTMLElement, { moved: () => void; arrived: () => void; stop: () => void }>();

/** The timeline's layout was just moved by code; the rise draws from before it. */
export function timelineLayoutMoved(scrollRoot: HTMLElement | null) {
  if (scrollRoot) risingTimelines.get(scrollRoot)?.moved();
}

function motionReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The new row itself comes up out of the composer as it appears. */
export function playSentRowEntrance(scrollRoot: HTMLElement | null, sentRow: HTMLElement) {
  if (scrollRoot) risingTimelines.get(scrollRoot)?.arrived();
  if (typeof sentRow.animate !== "function" || motionReduced()) return;
  sentRow.animate(
    [
      { opacity: 0, transform: `translateY(${Math.min(sentRow.offsetHeight, SEND_RISE_MIN_PX)}px)` },
      { opacity: 1, offset: 0.6 },
      { opacity: 1, transform: "none" },
    ],
    { duration: SEND_RISE_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
}

/**
 * Starts drawing the rows from where they stand now. Called while the page
 * still shows the timeline without the new row: the list makes room for it,
 * and the timeline is scrolled there, before the row itself has mounted.
 */
export function beginTimelineSendRise(scrollRoot: HTMLElement) {
  const rows = scrollRoot.querySelectorAll<HTMLElement>("[data-timeline-rise-row]");
  // The newest row's place in the list: the row's own node is drawn elsewhere.
  const place = rows[rows.length - 1]?.parentElement;
  if (!place || motionReduced()) return;
  risingTimelines.get(scrollRoot)?.stop();

  /* How far below their place in the layout the rows are drawn. A move of the
     layout adds to it, so the rows stay where they were on screen; time takes
     it away. A reader who sent from further up is brought down by more than a
     screen: that is a jump, not a rise, and is not drawn. */
  let lag = 0;
  let laidOutAt = place.getBoundingClientRect().top;
  /* Time only counts between painted frames. A move is found in the middle of
     a long task as often as not, and one slow frame must not use up the rise:
     a frame takes away no more than two frames' worth.

     The layout arrives in steps a frame or two apart, and not all the same
     way: room for the row by an estimate, the estimate corrected, the composer
     shrinking. The rows wait where they are until a frame passes without one,
     and then travel the sum, so they set off once and in one direction. */
  let paintedAt = 0;
  let quietFrames = 0;
  // Not before the new row is in: the composer can give way a frame ahead of it.
  let arrived = false;
  const startedAt = performance.now();
  const until = performance.now() + SEND_RISE_FRESH_MS;
  const drawn = new Set<HTMLElement>();
  const draw = (frameAt?: number) => {
    if (!place.isConnected) {
      stop();
      return;
    }
    const top = place.getBoundingClientRect().top;
    const moved = top - laidOutAt;
    laidOutAt = top;
    if (Math.abs(moved) > scrollRoot.clientHeight) lag = 0;
    else if (Math.abs(moved) >= 0.01) {
      lag -= moved;
      quietFrames = 0;
    } else if (frameAt !== undefined) {
      quietFrames += 1;
      if (!arrived && frameAt - startedAt > SEND_RISE_MS) arrived = true;
      if (arrived && quietFrames > SEND_RISE_QUIET_FRAMES) {
        lag *= Math.exp(-SEND_RISE_PER_MS * Math.min(frameAt - paintedAt, SEND_RISE_FRAME_MAX_MS));
      }
      paintedAt = frameAt;
    }
    if (Math.abs(lag) < 0.25) lag = 0;
    for (const row of drawn) {
      if (!row.isConnected) drawn.delete(row);
    }
    if (lag !== 0) {
      for (const row of scrollRoot.querySelectorAll<HTMLElement>("[data-timeline-rise-row]")) drawn.add(row);
    }
    for (const row of drawn) row.style.translate = lag === 0 ? "" : `0 ${lag}px`;
    if (lag === 0) drawn.clear();
  };
  const moved = () => draw();

  /* A move reaches the page in a task between two frames, while a frame lays
     out, or when code scrolls the timeline; each is drawn before it is painted. */
  let frame = requestAnimationFrame(function eachFrame(frameAt) {
    draw(frameAt);
    if (lag === 0 && performance.now() > until) stop();
    else frame = requestAnimationFrame(eachFrame);
  });
  const sizes = new ResizeObserver(moved);
  observeTimelineBoxes(scrollRoot, sizes);
  for (const probe of scrollRoot.querySelectorAll(`[${TIMELINE_HEIGHT_PROBE_ATTRIBUTE}]`)) sizes.observe(probe);
  // The composer changing height moves the timeline's end without resizing
  // anything an observer is told about in the same frame; it says so itself.
  const surface = messageSurfaceOf(scrollRoot);
  surface?.addEventListener(MESSAGE_SURFACE_METRICS_EVENT, moved);
  // The reader's own scrolling is theirs: nothing is held back against it.
  const release = () => stop();
  scrollRoot.addEventListener("wheel", release, { passive: true });
  scrollRoot.addEventListener("touchmove", release, { passive: true });
  function stop() {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    scrollRoot.removeEventListener("wheel", release);
    scrollRoot.removeEventListener("touchmove", release);
    surface?.removeEventListener(MESSAGE_SURFACE_METRICS_EVENT, moved);
    for (const row of drawn) row.style.translate = "";
    drawn.clear();
    if (risingTimelines.get(scrollRoot)?.stop === stop) risingTimelines.delete(scrollRoot);
  }
  risingTimelines.set(scrollRoot, { moved, arrived: () => { arrived = true; }, stop });
}

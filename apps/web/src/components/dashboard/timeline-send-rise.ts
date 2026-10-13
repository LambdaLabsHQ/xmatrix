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
   one way and slow to a stop (user 2026-10-10: "没必要弹一下然后回来，就是逐渐速度减到 0").

   The list is drawn lower as one piece, never row by row: the virtualizer
   mounts rows of its own during a rise, and a row left out of the offset was
   drawn over its neighbours (user 2026-10-13: "这个渲染怎么回事"). */

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
const risingTimelines = new WeakMap<HTMLElement, {
  moved: () => void;
  arrived: () => void;
  /** Ends the rise and gives back how far below its place the list was drawn. */
  stop: () => number;
}>();

/* The virtualizer's content box: the header, every row it has mounted and the
   footer, in one element. */
const TIMELINE_CONTENT = "[data-viewport-type]";

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
  if (motionReduced()) return;
  // A rise still under way hands over what is left of it: the list goes on
  // from where it is drawn instead of jumping to its place.
  const carried = risingTimelines.get(scrollRoot)?.stop() ?? 0;
  const content = scrollRoot.querySelector<HTMLElement>(TIMELINE_CONTENT);
  // While the list is drawn lower its end must not reach past the footer: the
  // timeline would count as scrolled up from the bottom.
  const clip = content?.parentElement;
  // Follow a row itself: its offset within the list can change too. A row
  // still playing its entrance has a transform of its own, so use the newest
  // one that is standing still.
  const rows = content?.querySelectorAll<HTMLElement>("[data-timeline-rise-row]") ?? [];
  const anchor = Array.from(rows).reverse().find(row => row.getAnimations().length === 0);
  if (!content || !clip || !anchor) return;

  /* How far below its place in the layout the list is drawn. A move of the
     layout adds to it, so the rows stay where they were on screen; time takes
     it away. A reader who sent from further up is brought down by more than a
     screen: that is a jump, not a rise, and is not drawn. */
  let lag = carried;
  let laidOutAt = anchor.getBoundingClientRect().top - lag;
  /* Time only counts between painted frames. A move is found in the middle of
     a long task as often as not, and one slow frame must not use up the rise:
     a frame takes away no more than two frames' worth.

     The layout arrives in steps a frame or two apart, and not all the same
     way: room for the row by an estimate, the estimate corrected, the composer
     shrinking. The list waits where it is until a frame passes without one,
     and then travels the sum, so it sets off once and in one direction. */
  let paintedAt = 0;
  let quietFrames = 0;
  // Not before the new row is in: the composer can give way a frame ahead of it.
  let arrived = false;
  const startedAt = performance.now();
  const until = performance.now() + SEND_RISE_FRESH_MS;
  const draw = (frameAt?: number) => {
    if (!anchor.isConnected) {
      stop();
      return;
    }
    // Remove the offset last drawn to measure where the layout put the row.
    const top = anchor.getBoundingClientRect().top - lag;
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
    content.style.translate = lag === 0 ? "" : `0 ${lag}px`;
    clip.style.overflow = lag === 0 ? "" : "clip";
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
  const stop = (): number => {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    scrollRoot.removeEventListener("wheel", release);
    scrollRoot.removeEventListener("touchmove", release);
    surface?.removeEventListener(MESSAGE_SURFACE_METRICS_EVENT, moved);
    content.style.translate = "";
    clip.style.overflow = "";
    if (risingTimelines.get(scrollRoot)?.stop === stop) risingTimelines.delete(scrollRoot);
    const left = anchor.isConnected ? lag : 0;
    lag = 0;
    return left;
  };
  risingTimelines.set(scrollRoot, { moved, arrived: () => { arrived = true; }, stop });
}

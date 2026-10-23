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
const SEND_RISE_QUIET_FRAMES = 1;
/* A short timeline has nothing to scroll, so its rows stay put and the new row
   alone rises this far. */
const SEND_RISE_MIN_PX = 24;
/* A row counts as just sent only this long after the send. The virtualizer
   mounts rows again as they scroll back into view, and a queued send can be
   restored much later; neither is a send the reader is watching. The layout
   can also still be corrected this long after a rise began. */
const SEND_RISE_FRESH_MS = 1_500;
/* Closer to its place than this, the list is drawn in it. */
const SEND_RISE_REST_PX = 0.25;
/* The way to rest is given to the compositor as this many straight pieces of
   the same curve, so it is drawn without a frame of the page's own work. */
const SEND_RISE_PIECES = 24;

/** Marks the elements that are as tall as the list's content (see their component). */
export const TIMELINE_HEIGHT_PROBE_ATTRIBUTE = "data-timeline-height-probe";

export function isJustSentRow(message: { own?: boolean; sendStatus?: string; sentAt: string }): boolean {
  return Boolean(message.own) && message.sendStatus === "pending" &&
    Date.now() - Date.parse(message.sentAt) < SEND_RISE_FRESH_MS;
}

/** The rise each timeline is playing: a layout move reported to it, and its end. */
const risingTimelines = new WeakMap<HTMLElement, {
  moved: () => void;
  /** The new row is in, coming up on its own `entrance` (none under reduced motion). */
  arrived: (entrance: Animation | null) => void;
  /** Ends the rise and gives back how far below its place the list was drawn. */
  stop: () => number;
}>();

/* The visual layer holds the header, mounted rows and footer together. Its
   measured Virtuoso viewport stays still, so a rise cannot change the layout
   offset reported to the custom scroll parent. */
const TIMELINE_CONTENT = "[data-timeline-rise-content]";

/** The timeline's layout was just moved by code; the rise draws from before it. */
export function timelineLayoutMoved(scrollRoot: HTMLElement | null) {
  if (scrollRoot) risingTimelines.get(scrollRoot)?.moved();
}

function motionReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* The new row's own way up, fading in over the first three fifths of it: on
   this curve, as straight pieces of it, so the same way can be given a still
   end without being drawn any differently. */
const ENTRANCE_CURVE = [0.2, 0.8, 0.2, 1] as const;
const ENTRANCE_PIECES = 16;

/** How far along the entrance is `time` of SEND_RISE_MS in (cubic-bezier ENTRANCE_CURVE). */
function entranceProgress(time: number): number {
  if (time <= 0) return 0;
  if (time >= 1) return 1;
  const [x1, y1, x2, y2] = ENTRANCE_CURVE;
  const at = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (at(x1, x2, middle) < time) low = middle;
    else high = middle;
  }
  return at(y1, y2, (low + high) / 2);
}

/**
 * The entrance drawn over `duration` ms: the way up in its first
 * SEND_RISE_MS, the row standing in its place for the rest.
 */
function entranceKeyframes(duration: number): Keyframe[] {
  const frames: Keyframe[] = Array.from({ length: ENTRANCE_PIECES + 1 }, (_, piece) => {
    const progress = entranceProgress(piece / ENTRANCE_PIECES);
    return {
      offset: (SEND_RISE_MS * piece) / ENTRANCE_PIECES / duration,
      opacity: Math.min(1, progress / 0.6),
      transform: piece === ENTRANCE_PIECES ? "none" : `translateY(${SEND_RISE_MIN_PX * (1 - progress)}px)`,
    };
  });
  return duration > SEND_RISE_MS ? [...frames, { offset: 1, opacity: 1, transform: "none" }] : frames;
}

/**
 * The new row itself comes up out of the composer as it appears, from as far
 * below as a short timeline's rows rise: its height is not read, which would
 * lay the page out in the middle of putting the row in.
 */
export function playSentRowEntrance(scrollRoot: HTMLElement | null, sentRow: HTMLElement) {
  const entrance = typeof sentRow.animate === "function" && !motionReduced()
    ? sentRow.animate(entranceKeyframes(SEND_RISE_MS), { duration: SEND_RISE_MS, easing: "linear" })
    : null;
  if (scrollRoot) risingTimelines.get(scrollRoot)?.arrived(entrance);
}

/** Has the row's entrance last `duration` ms: its way up, then standing still. */
function lastEntrance(entrance: Animation | null, duration: number) {
  const effect = entrance?.effect as KeyframeEffect | null | undefined;
  if (!entrance || !effect || entrance.playState !== "running") return;
  const length = Math.max(SEND_RISE_MS, duration);
  effect.setKeyframes(entranceKeyframes(length));
  effect.updateTiming({ duration: length });
}

/**
 * Has the row's entrance end when the list's rise does, standing still after
 * its way up. The end of an animation wakes the page ahead of it and lays its
 * layers out again once it is over; ending together, the two do that once.
 */
function endEntranceWith(entrance: Animation | null, rise: Animation, riseDuration: number) {
  if (!entrance) return;
  // The rise starts when the compositor gets to it, which a busy page learns a
  // few frames late; the row stands still in its place until then.
  void rise.ready.then(() => {
    const riseStart = rise.startTime === null ? NaN : Number(rise.startTime);
    const entranceStart = entrance.startTime === null ? NaN : Number(entrance.startTime);
    if (Number.isFinite(riseStart) && Number.isFinite(entranceStart)) lastEntrance(entrance, riseStart + riseDuration - entranceStart);
  }, () => undefined);
}

/** How long the list takes from `from` to rest, slowing all the way. */
function riseDuration(from: number): number {
  return Math.log(Math.abs(from) / SEND_RISE_REST_PX) / SEND_RISE_PER_MS;
}

/** Where a rise from `from` draws the list `elapsed` ms in: on the pieces the compositor draws. */
function riseOffset(from: number, duration: number, elapsed: number): number {
  if (elapsed <= 0) return from;
  if (elapsed >= duration) return 0;
  const corner = (piece: number) => piece >= SEND_RISE_PIECES
    ? 0
    : from * Math.exp(-SEND_RISE_PER_MS * duration * (piece / SEND_RISE_PIECES));
  const position = (elapsed / duration) * SEND_RISE_PIECES;
  const piece = Math.floor(position);
  return corner(piece) + (corner(piece + 1) - corner(piece)) * (position - piece);
}

/**
 * Starts drawing the rows from where they stand now. Called while the page
 * still shows the timeline without the new row: the list makes room for it,
 * and the timeline is scrolled there, before the row itself has mounted.
 *
 * The page's own work is only the holding: each move of the layout is met,
 * before it is painted, by drawing the list as far from its new place as it
 * stood. Once the new row is in and a frame has passed without a move, the
 * way to rest belongs to the compositor. Nothing runs between two moves.
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

  /* How far below its place in the layout the list is held. A move of the
     layout adds to it, so the rows stay where they were on screen. A reader
     who sent from further up is brought down by more than a screen: that is a
     jump, not a rise, and is not drawn. */
  let held = 0;
  /* The way to rest while the compositor draws it: the list is where that
     has brought it, which only the animation's own clock can say. */
  let resting: { animation: Animation; from: number; duration: number } | null = null;
  const drawn = () => resting
    ? riseOffset(resting.from, resting.duration, Number(resting.animation.currentTime ?? 0))
    : held;
  /* Draws the list standing still, `offset` below its place. Whatever was
     bringing it to rest ends in the same task, so no frame shows the list
     anywhere else in between. */
  const hold = (offset: number) => {
    held = Math.abs(offset) < SEND_RISE_REST_PX ? 0 : offset;
    content.style.translate = held === 0 ? "" : `0 ${held}px`;
    clip.style.overflow = held === 0 ? "" : "clip";
    const ended = resting;
    resting = null;
    ended?.animation.cancel();
  };
  hold(carried);
  let laidOutAt = anchor.getBoundingClientRect().top - held;
  /* The layout arrives in steps a frame or two apart, and not all the same
     way: room for the row by an estimate, the estimate corrected, the composer
     shrinking. The list waits where it is until a frame passes without one,
     and then travels the sum, so it sets off once and in one direction. */
  let quietFrames = 0;
  // Not before the new row is in: the composer can give way a frame ahead of it.
  let arrived = false;
  let entrance: Animation | null = null;
  let stopped = false;
  let frame = 0;
  const startedAt = performance.now();
  const until = startedAt + SEND_RISE_FRESH_MS;

  /** Meets a move of the layout by holding the list where it was drawn. */
  const measure = (): boolean => {
    const offset = drawn();
    // Remove the offset drawn to measure where the layout put the row.
    const top = anchor.getBoundingClientRect().top - offset;
    const moved = top - laidOutAt;
    laidOutAt = top;
    if (Math.abs(moved) > scrollRoot.clientHeight) hold(0);
    else if (Math.abs(moved) >= 0.01) hold(offset - moved);
    else return false;
    return true;
  };
  /** The list sets off for its place, and the page's part in the rise is over. */
  const rest = () => {
    if (held === 0 || typeof content.animate !== "function") {
      hold(0);
      lastEntrance(entrance, Number(entrance?.currentTime ?? 0));
      return;
    }
    const from = held;
    const duration = riseDuration(from);
    const animation = content.animate(
      Array.from({ length: SEND_RISE_PIECES + 1 }, (_, piece) => ({
        translate: `0 ${riseOffset(from, duration, (duration * piece) / SEND_RISE_PIECES)}px`,
      })),
      { duration, easing: "linear" },
    );
    resting = { animation, from, duration };
    endEntranceWith(entrance, animation, duration);
    // The animation draws the list from here on; this is where it leaves it.
    held = 0;
    content.style.translate = "";
    animation.addEventListener("finish", () => {
      if (resting?.animation !== animation) return;
      resting = null;
      clip.style.overflow = "";
      if (anchor.isConnected) laidOutAt = anchor.getBoundingClientRect().top;
      if (performance.now() > until) stop();
    });
  };
  /* Counts the frames since the last move. Only a held list has frames to
     count: at rest, or on its way there, the next move wakes this again. */
  const eachFrame = (frameAt: number) => {
    frame = 0;
    if (stopped) return;
    if (!anchor.isConnected) {
      stop();
      return;
    }
    if (measure()) quietFrames = 0;
    else {
      quietFrames += 1;
      if (!arrived && frameAt - startedAt > SEND_RISE_MS) arrived = true;
      if (arrived && quietFrames > SEND_RISE_QUIET_FRAMES) {
        rest();
        if (!resting && performance.now() > until) stop();
        return;
      }
    }
    frame = requestAnimationFrame(eachFrame);
  };
  /* A move reaches the page in a task between two frames, while a frame lays
     out, or when the timeline is scrolled; each is met before it is painted. */
  const moved = () => {
    if (stopped) return;
    if (!anchor.isConnected) {
      stop();
      return;
    }
    if (!measure()) return;
    quietFrames = 0;
    if (!frame) frame = requestAnimationFrame(eachFrame);
  };

  frame = requestAnimationFrame(eachFrame);
  const sizes = new ResizeObserver(moved);
  observeTimelineBoxes(scrollRoot, sizes);
  for (const probe of scrollRoot.querySelectorAll(`[${TIMELINE_HEIGHT_PROBE_ATTRIBUTE}]`)) sizes.observe(probe);
  // The composer changing height moves the timeline's end without resizing
  // anything an observer is told about in the same frame; it says so itself.
  const surface = messageSurfaceOf(scrollRoot);
  surface?.addEventListener(MESSAGE_SURFACE_METRICS_EVENT, moved);
  // The list scrolling itself to its new end moves every row and resizes nothing.
  scrollRoot.addEventListener("scroll", moved, { passive: true });
  // The reader's own scrolling is theirs: nothing is held back against it.
  const release = () => stop();
  scrollRoot.addEventListener("wheel", release, { passive: true });
  scrollRoot.addEventListener("touchmove", release, { passive: true });
  // A correction can still come once the list is at rest; after this none is waited for.
  const expiry = window.setTimeout(() => {
    if (!frame && !resting) stop();
  }, SEND_RISE_FRESH_MS);
  const stop = (): number => {
    if (stopped) return 0;
    stopped = true;
    const left = anchor.isConnected ? drawn() : 0;
    cancelAnimationFrame(frame);
    frame = 0;
    window.clearTimeout(expiry);
    sizes.disconnect();
    scrollRoot.removeEventListener("scroll", moved);
    scrollRoot.removeEventListener("wheel", release);
    scrollRoot.removeEventListener("touchmove", release);
    surface?.removeEventListener(MESSAGE_SURFACE_METRICS_EVENT, moved);
    hold(0);
    lastEntrance(entrance, Number(entrance?.currentTime ?? 0));
    if (risingTimelines.get(scrollRoot)?.stop === stop) risingTimelines.delete(scrollRoot);
    return left;
  };
  risingTimelines.set(scrollRoot, {
    moved,
    arrived: (rowEntrance) => {
      arrived = true;
      entrance = rowEntrance;
      /* A busy page can take longer than the row's way up to see the layout
         settle and the list set off. The row stands still in its place until
         then, so the two can still end together. */
      lastEntrance(entrance, SEND_RISE_FRESH_MS);
      if (resting) endEntranceWith(entrance, resting.animation, resting.duration);
    },
    stop,
  });
}

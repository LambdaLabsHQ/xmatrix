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
   down. Each is met where the rows are drawn: the list is drawn as far from
   its new place as it stood, and goes on from there as fast as it was going.

   The way there is a critically damped spring, x(t) = (x0 + (v0 + ωx0)t)e^(−ωt):
   both where the list is drawn and how fast it moves are continuous, so a
   step of the layout on the way changes where it is going and not its speed.
   It used to stand still at each step and set off again along a fresh
   exponential, whose start is its fastest: fast, stopped, fast again, and a
   step after it had come to rest set it off once more (user 2026-10-24:
   "挺住了之后，还会有轻微的小抖动，那个运动曲线有问题。数学上就不太对"). From
   standing the spring sets off gently, while the layout's own corrections
   are still landing, slows all the way and never passes its place (user
   2026-10-10: "没必要弹一下然后回来，就是逐渐速度减到 0").

   The list is drawn lower as one piece, never row by row: the virtualizer
   mounts rows of its own during a rise, and a row left out of the offset was
   drawn over its neighbours (user 2026-10-13: "这个渲染怎么回事"). */

const SEND_RISE_MS = 260;
/* The spring's ω, per millisecond: a row's room travelled in about 0.3 s. */
const SEND_RISE_RATE = 0.026;
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
/* The spring is followed until it is this close and moves less than this in
   a piece: a last piece any longer would go faster than the spring there. */
const SEND_RISE_SETTLED_PX = 0.05;
/* The way to rest is given to the compositor as straight pieces of the
   spring this long, so it is drawn without a frame of the page's own work. */
const SEND_RISE_PIECE_MS = 8;
const SEND_RISE_LONGEST_MS = 1_200;

/** Marks the elements that are as tall as the list's content (see their component). */
export const TIMELINE_HEIGHT_PROBE_ATTRIBUTE = "data-timeline-height-probe";

export function isJustSentRow(message: { own?: boolean; sendStatus?: string; sentAt: string }): boolean {
  return Boolean(message.own) && message.sendStatus === "pending" &&
    Date.now() - Date.parse(message.sentAt) < SEND_RISE_FRESH_MS;
}

/** How far below its place the list is drawn, and its speed downwards in px/ms. */
type RiseState = { offset: number; velocity: number };
const AT_REST: RiseState = { offset: 0, velocity: 0 };

/** The rise each timeline is playing: a layout move reported to it, and its end. */
const risingTimelines = new WeakMap<HTMLElement, {
  moved: () => void;
  /** The new row is in, coming up on its own `entrance` (none under reduced motion). */
  arrived: (entrance: Animation | null) => void;
  /** Ends the rise and gives back where the list was drawn below its place, and how fast it was going (px/ms). */
  stop: () => RiseState;
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

/** The spring `elapsed` ms after it was where `from` is, going at `velocity`. */
function springAt(from: number, velocity: number, elapsed: number): RiseState {
  const carry = velocity + SEND_RISE_RATE * from;
  const decay = Math.exp(-SEND_RISE_RATE * elapsed);
  return { offset: (from + carry * elapsed) * decay, velocity: (velocity - SEND_RISE_RATE * carry * elapsed) * decay };
}

/** The list's way to rest from `from` at `velocity`: the spring as the compositor draws it. */
type RiseWay = { from: number; velocity: number; corners: number[]; duration: number };

function riseWay(from: number, velocity: number): RiseWay {
  /* The list only ever goes towards its place. Going there faster than the
     spring itself would, it would pass it and come back, so it slows to the
     spring's own speed. Going away from it (the layout moved past where the
     list is drawn), it would carry on and come back, so it sets off from
     standing instead. */
  const towards = Math.sign(velocity) === -Math.sign(from);
  const speed = !towards ? 0
    : Math.abs(velocity) > SEND_RISE_RATE * Math.abs(from) ? -SEND_RISE_RATE * from : velocity;
  const corners = [from];
  for (let elapsed = SEND_RISE_PIECE_MS; elapsed < SEND_RISE_LONGEST_MS; elapsed += SEND_RISE_PIECE_MS) {
    const at = springAt(from, speed, elapsed);
    corners.push(at.offset);
    if (Math.abs(at.offset) < SEND_RISE_SETTLED_PX && Math.abs(at.velocity) * SEND_RISE_PIECE_MS < SEND_RISE_SETTLED_PX) break;
  }
  // The last piece only puts the list in its place from closer than can be seen.
  corners.push(0);
  return { from, velocity: speed, corners, duration: (corners.length - 1) * SEND_RISE_PIECE_MS };
}

/** The way, standing in its place at its end until `duration` ms have passed. */
function riseWayLasting(way: RiseWay, duration: number): RiseWay {
  const pieces = Math.ceil(duration / SEND_RISE_PIECE_MS);
  const corners = [...way.corners];
  while (corners.length - 1 < pieces) corners.push(0);
  return { ...way, corners, duration: (corners.length - 1) * SEND_RISE_PIECE_MS };
}

function riseKeyframes(way: RiseWay): Keyframe[] {
  return way.corners.map((corner) => ({ translate: `0 ${corner}px` }));
}

/** Where a way draws the list `elapsed` ms in, and how fast it goes there. */
function riseAt(way: RiseWay, elapsed: number): RiseState {
  if (elapsed >= way.duration) return AT_REST;
  if (elapsed <= 0) return { offset: way.from, velocity: way.velocity };
  const position = elapsed / SEND_RISE_PIECE_MS;
  const piece = Math.floor(position);
  const offset = way.corners[piece]! + (way.corners[piece + 1]! - way.corners[piece]!) * (position - piece);
  return { offset, velocity: springAt(way.from, way.velocity, elapsed).velocity };
}

/**
 * Starts drawing the rows from where they stand now. Called while the page
 * still shows the timeline without the new row: the list makes room for it,
 * and the timeline is scrolled there, before the row itself has mounted.
 *
 * The page's own work is only meeting each move of the layout, before it is
 * painted, by drawing the list as far from its new place as it stood and
 * handing the compositor the spring from there. Nothing runs between two moves.
 */
export function beginTimelineSendRise(scrollRoot: HTMLElement) {
  beginTimelineRise(scrollRoot, null);
}

/**
 * The timeline grew or shrank at its end (the work dock coming or going, a
 * chip changing) and `land` keeps it on its newest message. The rows the
 * reader saw stood with the timeline scrolled to `drawnAt`; they go to their
 * new place along the same spring, instead of in one frame. A rise under way
 * meets the move itself.
 */
export function glideTimelineLanding(scrollRoot: HTMLElement, land: () => void, drawnAt: number) {
  const clip = scrollRoot.querySelector<HTMLElement>(TIMELINE_CONTENT)?.parentElement;
  if (risingTimelines.has(scrollRoot) || motionReduced() || !clip) {
    land();
    return;
  }
  // Clipped as a rise draws it before landing, so the landing is where the rise leaves the list.
  clip.style.overflow = "clip";
  land();
  const offset = scrollRoot.scrollTop - drawnAt;
  if (Math.abs(offset) < SEND_RISE_REST_PX || Math.abs(offset) > scrollRoot.clientHeight) {
    clip.style.overflow = "";
    return;
  }
  beginTimelineRise(scrollRoot, offset);
}

/** A send's rise (`from` null: the new row is still to come), or a glide from `from` below. */
function beginTimelineRise(scrollRoot: HTMLElement, from: number | null) {
  if (motionReduced()) return;
  // A rise still under way hands over what is left of it: the list goes on
  // from where it is drawn, as fast as it was going.
  const carried = from === null ? { ...risingTimelines.get(scrollRoot)?.stop() ?? AT_REST } : { offset: from, velocity: 0 };
  const content = scrollRoot.querySelector<HTMLElement>(TIMELINE_CONTENT);
  const clip = content?.parentElement;
  // Follow a row itself: its offset within the list can change too. A row
  // still playing its entrance has a transform of its own, so use the newest
  // one that is standing still.
  const rows = content?.querySelectorAll<HTMLElement>("[data-timeline-rise-row]") ?? [];
  const anchor = Array.from(rows).reverse().find(row => row.getAnimations().length === 0);
  if (!content || !clip || !anchor) return;
  /* While the list is drawn lower its end must not reach past the footer, so
     it is clipped to the virtualizer's height for the whole rise. That height
     follows the rows a step late, and clipping can take the list's overflow
     past it out of the timeline and scroll the timeline back: the rows are
     met where they were drawn. */
  const drawnAt = anchor.getBoundingClientRect().top;
  clip.style.overflow = "clip";
  carried.offset += drawnAt - anchor.getBoundingClientRect().top;

  /* How far below its place in the layout the list stands while it waits for
     the new row. A reader who sent from further up is brought down by more
     than a screen: that is a jump, not a rise, and is not drawn. */
  let held = 0;
  /* The spring the compositor is drawing: where it has brought the list only
     the animation's own clock can say. */
  let way: { animation: Animation; path: RiseWay } | null = null;
  const isMoving = () => way !== null && way.animation.playState === "running" && way.animation.startTime !== null;
  const drawn = (): RiseState => way
    ? riseAt(way.path, Number(way.animation.currentTime ?? 0))
    : { offset: held, velocity: 0 };
  /* Draws the list standing still, `offset` below its place. Whatever was
     bringing it to rest ends in the same task, so no frame shows the list
     anywhere else in between. */
  const stand = (offset: number) => {
    held = Math.abs(offset) < SEND_RISE_REST_PX ? 0 : offset;
    content.style.translate = held === 0 ? "" : `0 ${held}px`;
    const ended = way;
    way = null;
    ended?.animation.cancel();
  };
  // The list stands until the new row is in: the composer can give way a
  // frame ahead of it, and the list would set off the wrong way. A list that
  // was already moving keeps moving, and a glide has no row to wait for.
  let setOff = from !== null || carried.velocity !== 0;
  let entrance: Animation | null = null;
  let stopped = false;
  const startedAt = performance.now();
  const until = startedAt + SEND_RISE_FRESH_MS;

  /* The row's entrance and the list's way to rest end in the same frame. The
     end of an animation wakes the page ahead of it and lays its layers out
     again once it is over; ending together, the two do that once. The row
     stands still in its place after its way up until the list arrives, and a
     list that arrives first stands in its place until the row's way is over.
     The entrance starts when the compositor gets to it, which a busy page
     learns a few frames late. */
  const endWithEntrance = () => {
    const rise = way;
    const row = entrance;
    if (!rise || !row) return;
    void Promise.all([rise.animation.ready, row.ready]).then(() => {
      if (way !== rise || rise.animation.playState !== "running" || row.startTime === null) return;
      const riseStart = Number(rise.animation.startTime);
      const rowStart = Number(row.startTime);
      const rowWayEnd = rowStart + SEND_RISE_MS - riseStart;
      if (rise.path.duration < rowWayEnd) {
        rise.path = riseWayLasting(rise.path, rowWayEnd);
        const effect = rise.animation.effect as KeyframeEffect;
        effect.setKeyframes(riseKeyframes(rise.path));
        effect.updateTiming({ duration: rise.path.duration });
      }
      lastEntrance(row, riseStart + rise.path.duration - rowStart);
    }, () => undefined);
  };
  /**
   * The list goes from `offset` below its place at `velocity`, along the
   * spring. Taking over from a way still under way (`moving`), it goes on the
   * same clock from the same moment: waiting for the compositor to start it
   * would stand the list still. From standing it starts in the first frame
   * that draws it: the frame clock of a page busy putting the new row in is
   * behind, and starting on it would draw the list part of the way along at once.
   */
  const travel = ({ offset, velocity }: RiseState, moving: boolean) => {
    if (typeof content.animate !== "function" ||
        (Math.abs(offset) < SEND_RISE_REST_PX && Math.abs(velocity) * SEND_RISE_PIECE_MS < SEND_RISE_REST_PX)) {
      stand(0);
      lastEntrance(entrance, Number(entrance?.currentTime ?? 0));
      return;
    }
    const path = riseWay(offset, velocity);
    const animation = content.animate(riseKeyframes(path), { duration: path.duration, easing: "linear" });
    if (moving) animation.startTime = document.timeline.currentTime;
    const ended = way;
    way = { animation, path };
    ended?.animation.cancel();
    // The animation draws the list from here on; this is where it leaves it.
    held = 0;
    content.style.translate = "";
    endWithEntrance();
    animation.addEventListener("finish", () => {
      if (way?.animation !== animation) return;
      way = null;
      if (performance.now() > until) stop();
    });
  };
  if (setOff) travel(carried, carried.velocity !== 0);
  else stand(carried.offset);
  let laidOutAt = anchor.getBoundingClientRect().top - drawn().offset;

  /** Meets a move of the layout where the list is drawn. */
  const moved = () => {
    if (stopped) return;
    if (!anchor.isConnected) {
      stop();
      return;
    }
    const now = drawn();
    // Remove the offset drawn to measure where the layout put the row.
    const top = anchor.getBoundingClientRect().top - now.offset;
    const by = top - laidOutAt;
    laidOutAt = top;
    if (Math.abs(by) < 0.01) return;
    if (Math.abs(by) > scrollRoot.clientHeight) stand(0);
    else if (setOff) travel({ offset: now.offset - by, velocity: now.velocity }, isMoving());
    else stand(now.offset - by);
  };
  /** The new row is in: the list sets off from where it stands. */
  const arrive = () => {
    if (stopped || setOff) return;
    setOff = true;
    travel(drawn(), isMoving());
  };
  // A row that never says it is in (one the virtualizer did not draw) does not hold the list.
  const arrival = window.setTimeout(arrive, SEND_RISE_MS);

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
    if (!way) stop();
  }, SEND_RISE_FRESH_MS);
  const stop = (): RiseState => {
    if (stopped) return AT_REST;
    stopped = true;
    const left = anchor.isConnected ? drawn() : AT_REST;
    window.clearTimeout(arrival);
    window.clearTimeout(expiry);
    sizes.disconnect();
    scrollRoot.removeEventListener("scroll", moved);
    scrollRoot.removeEventListener("wheel", release);
    scrollRoot.removeEventListener("touchmove", release);
    surface?.removeEventListener(MESSAGE_SURFACE_METRICS_EVENT, moved);
    stand(0);
    clip.style.overflow = "";
    lastEntrance(entrance, Number(entrance?.currentTime ?? 0));
    if (risingTimelines.get(scrollRoot)?.stop === stop) risingTimelines.delete(scrollRoot);
    return left;
  };
  risingTimelines.set(scrollRoot, {
    moved,
    arrived: (rowEntrance) => {
      entrance = rowEntrance;
      /* A busy page can take longer than the row's way up to see the list set
         off. The row stands still in its place until then, so the two can
         still end together. */
      lastEntrance(entrance, SEND_RISE_FRESH_MS);
      endWithEntrance();
      arrive();
    },
    stop,
  });
}

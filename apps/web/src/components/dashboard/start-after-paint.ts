/*
 * A screen change that renders its new screen and then animates to it loses
 * the start of its animation on iOS: WebKit fixes the animation's start time
 * when it is played, before the frame that lays out and paints, so whatever
 * the main thread still does then is time the screen never shows. A spring
 * from rest covers half its way in under 80 ms, so even a short busy frame
 * leaves only the last few points of the push to see.
 *
 * The new screen is not done when its first frame is: the effects it mounts
 * (the timeline scrolling to its end, rows measured, the read cursor) run in
 * the frames after. So the animations are held at their first pose until a
 * frame comes round on time, which is one the main thread had nothing left
 * to do in, and start there. A main thread that never goes quiet does not hold
 * the screen for long: past MAX_HOLD_MS they start anyway.
 *
 * Everything held meanwhile starts on the same frame, so the parts of one
 * change held from different places (a dock tab's track and its bar) move
 * together. A change that animates first and renders after (Back to the
 * channel list) does not need this.
 */

/** A frame that came this soon after the last one had nothing left over from it. 60 Hz with room to spare; 120 Hz frames come sooner. */
const ON_TIME_FRAME_MS = 24;
/** The longest a change waits for the main thread before it moves regardless. */
const MAX_HOLD_MS = 300;

let held: Animation[] = [];
let heldSince = 0;
let waiting = false;

function startHeld() {
  const starting = held;
  held = [];
  waiting = false;
  // One cancelled meanwhile stays cancelled: play() would start it again.
  for (const animation of starting) if (animation.playState === "paused") animation.play();
}

function waitForQuietFrame() {
  let frames = 0;
  let previous = 0;
  const frame = () => {
    // When the callback runs, not the frame's own timestamp: a frame the main
    // thread made late can still carry the time it was meant to start at.
    const now = performance.now();
    frames += 1;
    const onTime = frames > 1 && now - previous <= ON_TIME_FRAME_MS;
    previous = now;
    // The first frame paints the new screen; one after it that came on time had nothing left to do.
    if (frames > 1 && (onTime || now - heldSince >= MAX_HOLD_MS)) {
      startHeld();
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function startAfterPaint(animations: Array<Animation | null | undefined>): void {
  const holding = animations.filter((animation): animation is Animation => Boolean(animation));
  if (!holding.length) return;
  for (const animation of holding) animation.pause();
  held.push(...holding);
  if (waiting) return;
  waiting = true;
  heldSince = performance.now();
  waitForQuietFrame();
}

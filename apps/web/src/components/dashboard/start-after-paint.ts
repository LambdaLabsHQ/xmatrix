/*
 * A screen change that renders its new screen and then animates to it loses
 * the start of its animation on iOS: WebKit fixes the animation's start time
 * before the frame that lays out and paints the new screen, so by the time
 * that frame reaches the display most of the way has gone, and the screen
 * jumps nearly to the end and drifts the last few points. The animations are
 * held at their first pose through that frame and start on the next one,
 * which has nothing left to do. A change that animates first and renders after
 * (Back to the channel list) does not need this.
 */
export function startAfterPaint(animations: Array<Animation | null | undefined>): void {
  const held = animations.filter((animation): animation is Animation => Boolean(animation));
  if (!held.length) return;
  for (const animation of held) animation.pause();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // One cancelled meanwhile stays cancelled: play() would start it again.
    for (const animation of held) if (animation.playState === "paused") animation.play();
  }));
}

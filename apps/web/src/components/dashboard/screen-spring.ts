/*
 * The one motion a phone's screen changes share: a critically damped spring.
 * It leaves at the speed it is given, never overshoots and has settled a
 * screen's width in about 0.4 s. A change hands the compositor keyframes
 * sampled from it, so the screen lands smoothly whatever the main thread does.
 */

/** How stiff the spring is. */
export const SETTLE_RATE = 22;

/** How far from its target the spring is `t` s after leaving `offset` px from it at `speed` px/s. */
export function springOffset(offset: number, speed: number, t: number): number {
  return (offset + (speed + SETTLE_RATE * offset) * t) * Math.exp(-SETTLE_RATE * t);
}

/** Its speed then, in px/s, for a change that takes over from one under way. */
export function springSpeed(offset: number, speed: number, t: number): number {
  return (speed - SETTLE_RATE * (speed + SETTLE_RATE * offset) * t) * Math.exp(-SETTLE_RATE * t);
}

/** When the spring is within half a pixel of its target for good, in s. */
export function springDuration(offset: number, speed: number): number {
  let settledAt = 0;
  for (let t = 0; t <= 1; t += 1 / 240) {
    if (Math.abs(springOffset(offset, speed, t)) >= 0.5) settledAt = t + 1 / 240;
  }
  return Math.max(settledAt, 0.12);
}

/** How far along (0 to 1) a change from rest is `t` s in. */
export function springProgress(t: number): number {
  return 1 - springOffset(1, 0, t);
}

/** Points sampled from the spring for the compositor's keyframes. */
export const SPRING_SAMPLES = 60;

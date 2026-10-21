/* Geometry and physics behind the attachment image viewer, kept free of the DOM
   so the feel of its edges, flicks and springs can be tested directly.
   Times are milliseconds, distances CSS pixels, velocities pixels per ms. */

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
/** translate(x, y) scale(scale) about the image's centre, which rests at the viewport's centre. */
export type ViewTransform = { scale: number; x: number; y: number };
/** A rectangle by its centre, measured from the viewport's centre. */
export type CenteredRect = Point & Size;
/** Insets that crop the image to a thumbnail, in the image's own pixels. */
export type Crop = { x: number; y: number; radius: number };

export const FIT_VIEW: ViewTransform = { scale: 1, x: 0, y: 0 };
/** Below this the image counts as fitted: drags page and dismiss instead of panning. */
export const ZOOMED_SCALE = 1.01;

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** The deepest zoom: eight times the fitted size, or far enough to reach the image's own pixels. */
export function maxZoom(naturalScale: number) {
  return Math.max(8, naturalScale);
}

/** How far the image may move from the centre before one of its edges comes into view. */
export function panLimits(image: Size, viewport: Size, scale: number): Point {
  return {
    x: Math.max(0, (image.width * scale - viewport.width) / 2),
    y: Math.max(0, (image.height * scale - viewport.height) / 2),
  };
}

/** Two fingers keep the image points they first touched: spread sets the scale, their midpoint the place. */
export function pinchView(start: ViewTransform, startAnchor: Point, anchor: Point, scale: number): ViewTransform {
  const ratio = scale / start.scale;
  return {
    scale,
    x: anchor.x - (startAnchor.x - start.x) * ratio,
    y: anchor.y - (startAnchor.y - start.y) * ratio,
  };
}

/** Zoom while the image point under `anchor` stays where it is. */
export function zoomAt(view: ViewTransform, scale: number, anchor: Point): ViewTransform {
  return pinchView(view, anchor, anchor, scale);
}

/** Where a view comes to rest: scale within range, and no gap between an image edge and the viewport. */
export function settleView(view: ViewTransform, image: Size, viewport: Size, maxScale: number, anchor: Point = { x: 0, y: 0 }): ViewTransform {
  const scale = clamp(view.scale, 1, maxScale);
  const zoomed = scale === view.scale ? view : zoomAt(view, scale, anchor);
  const limits = panLimits(image, viewport, scale);
  // `+ 0` turns the -0 a zero limit clamps to into 0.
  return { scale, x: clamp(zoomed.x, -limits.x, limits.x) + 0, y: clamp(zoomed.y, -limits.y, limits.y) + 0 };
}

/** Apple's rubber band: past an edge the content follows less the further it is pulled. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export function resist(value: number, min: number, max: number, dimension: number) {
  if (value < min) return min - rubberband(min - value, dimension);
  if (value > max) return max + rubberband(value - max, dimension);
  return value;
}

/** A view a finger is holding: inside the limits it follows 1:1, past them it strains against the edge. */
export function elasticView(view: ViewTransform, image: Size, viewport: Size): ViewTransform {
  const limits = panLimits(image, viewport, view.scale);
  return {
    scale: view.scale,
    x: resist(view.x, -limits.x, limits.x, viewport.width),
    y: resist(view.y, -limits.y, limits.y, viewport.height),
  };
}

/** Pinching past fit or past the deepest zoom gives way slowly instead of stopping dead. */
export function elasticScale(scale: number, maxScale: number) {
  if (scale < 1) return 1 - rubberband(1 - scale, 1);
  if (scale > maxScale) return maxScale + rubberband(scale - maxScale, maxScale);
  return scale;
}

/** Double tap zooms to where the image's own pixels are legible, at least 2x, and back to fit. */
export function doubleTapView(view: ViewTransform, anchor: Point, image: Size, viewport: Size, naturalScale: number): ViewTransform {
  if (view.scale > ZOOMED_SCALE) return FIT_VIEW;
  const maxScale = maxZoom(naturalScale);
  const scale = clamp(naturalScale, 2, 4);
  return settleView(zoomAt(view, scale, anchor), image, viewport, maxScale);
}

/** The view that lays the image over its thumbnail, and the crop that matches the thumbnail's object-fit: cover. */
export function thumbnailView(thumbnail: CenteredRect, image: Size, radius: number): { view: ViewTransform; crop: Crop } {
  const scale = Math.max(thumbnail.width / image.width, thumbnail.height / image.height);
  return {
    view: { scale, x: thumbnail.x, y: thumbnail.y },
    crop: {
      x: Math.max(0, (image.width - thumbnail.width / scale) / 2),
      y: Math.max(0, (image.height - thumbnail.height / scale) / 2),
      radius: radius / scale,
    },
  };
}

export type MotionSample = Point & { time: number };

/** Faster than any real flick (8000px/s); input that reports more is bunched-up events, not a hand. */
const MAX_RELEASE_SPEED = 8;

/** Velocity over the last 100ms, so a finger that paused before lifting reads as still. */
export function releaseVelocity(samples: readonly MotionSample[], window = 100): Point {
  const last = samples[samples.length - 1];
  if (!last) return { x: 0, y: 0 };
  let first = last;
  for (let index = samples.length - 2; index >= 0 && last.time - samples[index].time <= window; index -= 1) {
    first = samples[index];
  }
  const elapsed = last.time - first.time;
  if (elapsed <= 0) {
    // A real move with no time between the events is as fast as a hand goes; a pixel of jitter is not.
    const burst = (delta: number) => (Math.abs(delta) >= 10 ? Math.sign(delta) * MAX_RELEASE_SPEED : 0);
    return { x: burst(last.x - first.x), y: burst(last.y - first.y) };
  }
  return {
    x: clamp((last.x - first.x) / elapsed, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED),
    y: clamp((last.y - first.y) / elapsed, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED),
  };
}

/** Keep only what releaseVelocity reads. */
export function recordSample(samples: MotionSample[], sample: MotionSample, window = 100) {
  samples.push(sample);
  while (samples.length > 2 && sample.time - samples[0].time > window) samples.shift();
}

/** How far a flick would carry under scroll-view deceleration. */
export function project(velocity: number, decelerationRate = 0.998) {
  return (velocity * decelerationRate) / (1 - decelerationRate);
}

/** A release at least this fast (px/ms) is a flick, which pages by its direction alone. */
const FLICK_SPEED = 0.25;

/** Which image a released swipe lands on: +1 the next, -1 the previous, 0 stay.
    `offset` is how far the gallery sits from the open image, wherever the drag began
    (it may have caught a slide already under way). A flick moves one image on from the
    one mostly on screen, so a flick back against a long drag returns to it; a slower
    release lands where its momentum carries it. Never more than one image away. */
export function swipeDirection(offset: number, velocity: number, pageWidth: number): -1 | 0 | 1 {
  if (pageWidth <= 0) return 0;
  const shown = Math.round(offset / pageWidth);
  const page = clamp(
    Math.abs(velocity) >= FLICK_SPEED ? shown + Math.sign(velocity) : Math.round((offset + project(velocity)) / pageWidth),
    -1,
    1
  );
  if (page === 0) return 0;
  // The gallery moved left: the next image is coming in.
  return page < 0 ? 1 : -1;
}

/** Whether a vertical drag released here should close the viewer. */
export function shouldDismiss(offset: number, velocity: number, viewportHeight: number) {
  const projected = offset + project(velocity);
  return Math.abs(projected) > viewportHeight * 0.22 && Math.sign(projected) === Math.sign(offset);
}

/** Apple's parameters: `response` is the undamped period in ms, `damping` 1 settles with no overshoot. */
export type Spring = { response: number; damping: number };
export type Motion = { value: number; velocity: number };

/** Exact damped-spring motion over one step, so any frame length stays stable. */
export function stepSpring(motion: Motion, target: number, dt: number, spring: Spring): Motion {
  const omega = (2 * Math.PI) / spring.response;
  const offset = motion.value - target;
  const velocity = motion.velocity;
  if (spring.damping >= 1) {
    const decay = Math.exp(-omega * dt);
    const growth = velocity + omega * offset;
    return {
      value: target + (offset + growth * dt) * decay,
      velocity: (velocity - omega * growth * dt) * decay,
    };
  }
  const zeta = spring.damping;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * dt);
  const cos = Math.cos(damped * dt);
  const sin = Math.sin(damped * dt);
  return {
    value: target + decay * (offset * cos + ((velocity + zeta * omega * offset) / damped) * sin),
    velocity: decay * (velocity * cos - ((offset * omega * omega + zeta * omega * velocity) / damped) * sin),
  };
}

const COAST_DECELERATION = 0.997;

/** Momentum after a pan: coasting slows like a scroll view; outside [min, max] a spring pulls it back. */
export function stepCoast(motion: Motion, min: number, max: number, dt: number, edge: Spring): Motion {
  if (motion.value < min || motion.value > max) {
    return stepSpring(motion, motion.value < min ? min : max, dt, edge);
  }
  const decay = Math.pow(COAST_DECELERATION, dt);
  return {
    value: motion.value + (motion.velocity * (decay - 1)) / Math.log(COAST_DECELERATION),
    velocity: motion.velocity * decay,
  };
}

/** The fastest a critically damped spring can leave `value` toward `target` and still land without overshooting it. */
export function landingVelocity(value: number, target: number, velocity: number, spring: Spring) {
  const limit = ((2 * Math.PI) / spring.response) * Math.abs(value - target);
  return clamp(velocity, -limit, limit);
}

/** One animated number: at rest, springing to a target, or coasting inside bounds. */
export type Channel = Motion & {
  mode: "rest" | "spring" | "coast";
  target: number;
  min: number;
  max: number;
  spring: Spring;
  /** Closer than this, and slower than a fiftieth of it per ms, counts as arrived. */
  epsilon: number;
};

export function createChannel(value: number, epsilon: number): Channel {
  return { value, velocity: 0, mode: "rest", target: value, min: -Infinity, max: Infinity, spring: { response: 400, damping: 1 }, epsilon };
}

/** Put the channel at a value and drop its motion, as when a finger catches it. */
export function holdChannel(channel: Channel, value = channel.value) {
  channel.value = value;
  channel.velocity = 0;
  channel.target = value;
  channel.mode = "rest";
}

/** Retarget from wherever the channel is now, keeping its velocity unless one is handed over. */
export function springChannel(channel: Channel, target: number, spring: Spring, velocity = channel.velocity) {
  channel.target = target;
  channel.spring = spring;
  channel.velocity = velocity;
  channel.mode = "spring";
}

export function coastChannel(channel: Channel, min: number, max: number, velocity: number, edge: Spring) {
  channel.min = min;
  channel.max = max;
  channel.velocity = velocity;
  channel.spring = edge;
  channel.mode = "coast";
}

/** Advance one frame. False once the channel has come to rest. */
export function advanceChannel(channel: Channel, dt: number): boolean {
  if (channel.mode === "rest") return false;
  const next = channel.mode === "spring"
    ? stepSpring(channel, channel.target, dt, channel.spring)
    : stepCoast(channel, channel.min, channel.max, dt, channel.spring);
  const destination = channel.mode === "spring" ? channel.target : clamp(next.value, channel.min, channel.max);
  if (Math.abs(next.value - destination) < channel.epsilon && Math.abs(next.velocity) < channel.epsilon / 50) {
    holdChannel(channel, destination);
    return false;
  }
  channel.value = next.value;
  channel.velocity = next.velocity;
  return true;
}

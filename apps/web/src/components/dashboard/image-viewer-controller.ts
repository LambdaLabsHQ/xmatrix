/* The attachment image viewer's input and motion, outside React: a gesture
   writes transforms straight to the elements every frame, and React only
   hears when the zoom readout or closing state changes. Every animation
   starts from what is on screen and can be caught by the next touch. */
import {
  FIT_VIEW,
  ZOOMED_SCALE,
  advanceChannel,
  clamp,
  coastChannel,
  createChannel,
  doubleTapView,
  elasticScale,
  elasticView,
  holdChannel,
  landingVelocity,
  maxZoom,
  panLimits,
  pinchView,
  recordSample,
  releaseVelocity,
  resist,
  settleView,
  shouldDismiss,
  springChannel,
  swipeDirection,
  thumbnailView,
  zoomAt,
  type CenteredRect,
  type Channel,
  type Crop,
  type MotionSample,
  type Point,
  type Size,
  type Spring,
  type ViewTransform,
} from "./image-viewer-motion";

export type GalleryImage = { id: string; name: string; src: string };

export type ImageViewerState = {
  images: readonly GalleryImage[];
  activeId: string;
  onActiveChange: (id: string) => void;
  onClose: () => void;
  originFor?: (id: string) => HTMLElement | null;
};

export type ImageViewerHost = {
  viewport: () => HTMLElement | null;
  track: () => HTMLElement | null;
  backdrop: () => HTMLElement | null;
  chrome: () => HTMLElement | null;
  images: ReadonlyMap<string, HTMLImageElement>;
  state: () => ImageViewerState;
  zoomChanged: (zoom: { zoomed: boolean; percent: number }) => void;
  closing: () => void;
};

/** Space between neighbouring images while they slide. */
export const SLIDE_GAP = 24;
/** One press of a zoom control or key. */
export const ZOOM_STEP = 1.6;

const OPEN: Spring = { response: 400, damping: 1 };
const CLOSE: Spring = { response: 300, damping: 1 };
const PAGE: Spring = { response: 380, damping: 1 };
const ZOOM: Spring = { response: 340, damping: 1 };
const WHEEL: Spring = { response: 170, damping: 1 };
const EDGE: Spring = { response: 420, damping: 1 };
/** A dismissal called off after a throw gets a little give, because a hand moved it. */
const RETURN: Spring = { response: 380, damping: 0.86 };
const FADE: Spring = { response: 260, damping: 1 };

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 30;
/** Held longer than this, a press is the system's long press (save image), not a tap. */
const LONG_PRESS_MS = 500;
/** An image that decodes later than this after opening fades in instead of growing from its thumbnail. */
const OPEN_FROM_THUMBNAIL_MS = 600;
/** A trackpad pinch or smooth scroll arrives as many small wheel steps; a mouse notch as one big one. */
const SMOOTH_WHEEL_DELTA = 50;

type Pinch = {
  kind: "pinch";
  ids: [number, number];
  startAnchor: Point;
  anchor: Point;
  startDistance: number;
  from: ViewTransform;
  /** The spread ratio before resistance, which is what pinch-to-close reads. */
  raw: number;
};

type Gesture =
  | { kind: "idle" }
  | { kind: "press"; id: number; start: Point; time: number; pointerType: string; onImage: boolean }
  | { kind: "pan"; id: number; start: Point; from: ViewTransform; samples: MotionSample[]; pinch?: Pinch }
  | { kind: "swipe"; id: number; start: Point; from: number; samples: MotionSample[] }
  | { kind: "dismiss"; id: number; start: Point; from: ViewTransform; samples: MotionSample[] }
  | Pinch;

type SafariGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: Point, second: Point) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function createImageViewer(host: ImageViewerHost) {
  const motion = {
    x: createChannel(0, 0.5),
    y: createChannel(0, 0.5),
    scale: createChannel(1, 0.001),
    track: createChannel(0, 0.5),
    backdrop: createChannel(0, 0.004),
    /** The open image stays invisible until it has somewhere to open from. */
    opacity: createChannel(0, 0.004),
    /** 1 crops the open image to its thumbnail, 0 shows all of it. */
    reveal: createChannel(0, 0.004),
  };
  const channels: Channel[] = Object.values(motion);
  const pointers = new Map<number, Point>();
  const createdAt = performance.now();
  let gesture: Gesture = { kind: "idle" };
  let crop: Crop | null = null;
  let naturalScale = 1;
  let opened = false;
  let closing = false;
  let closed = false;
  /** Closing without a thumbnail to return to: the whole picture fades with the backdrop. */
  let fadeOut = false;
  let frame: number | null = null;
  let lastFrame = 0;
  let restCallbacks: Array<() => void> = [];
  let pendingShift: { shift: number; velocity: number; time: number } | null = null;
  let shownId = host.state().activeId;
  let lastTap: { time: number; point: Point; pointerType: string } | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let safariPinch: { from: ViewTransform; anchor: Point } | null = null;
  let zoomReport = { zoomed: false, percent: 100 };

  function activeImage() {
    return host.images.get(host.state().activeId) ?? null;
  }

  function viewportSize(): Size {
    const viewport = host.viewport();
    return viewport ? { width: viewport.clientWidth, height: viewport.clientHeight } : { width: 0, height: 0 };
  }

  /** The image's fitted box: layout size, which transforms do not change. */
  function imageSize(): Size {
    const image = activeImage();
    return image ? { width: image.offsetWidth, height: image.offsetHeight } : { width: 0, height: 0 };
  }

  function pageWidth() {
    return viewportSize().width + SLIDE_GAP;
  }

  function currentView(): ViewTransform {
    return { scale: motion.scale.value, x: motion.x.value, y: motion.y.value };
  }

  /** Where the view is going, so a new zoom step builds on the last one instead of on a frame mid-flight. */
  function headingView(): ViewTransform {
    const heading = (channel: Channel) => (channel.mode === "spring" ? channel.target : channel.value);
    return { scale: heading(motion.scale), x: heading(motion.x), y: heading(motion.y) };
  }

  function local(event: { clientX?: number; clientY?: number }): Point {
    const rect = host.viewport()?.getBoundingClientRect();
    if (!rect || typeof event.clientX !== "number" || typeof event.clientY !== "number") return { x: 0, y: 0 };
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  }

  function measureNaturalScale() {
    const image = activeImage();
    naturalScale = image && image.offsetWidth > 0 && image.naturalWidth > 0 ? Math.max(1, image.naturalWidth / image.offsetWidth) : 1;
  }

  function render() {
    const image = activeImage();
    if (image) {
      image.style.transform = `translate3d(${motion.x.value}px, ${motion.y.value}px, 0) scale(${motion.scale.value})`;
      image.style.opacity = motion.opacity.value >= 1 ? "" : String(clamp(motion.opacity.value, 0, 1));
      const reveal = clamp(motion.reveal.value, 0, 1);
      image.style.clipPath = crop && reveal > 0.001
        ? `inset(${crop.y * reveal}px ${crop.x * reveal}px round ${crop.radius * reveal}px)`
        : "";
    }
    // The controls dim with the backdrop, so a dismiss drag fades them with it.
    const backdrop = String(clamp(motion.backdrop.value, 0, 1));
    const track = host.track();
    if (track) {
      track.style.transform = `translate3d(${motion.track.value}px, 0, 0)`;
      track.style.opacity = fadeOut ? backdrop : "";
    }
    const backdropElement = host.backdrop();
    if (backdropElement) backdropElement.style.opacity = backdrop;
    const chrome = host.chrome();
    if (chrome) chrome.style.opacity = backdrop;
    const heading = motion.scale.mode === "spring" ? motion.scale.target : motion.scale.value;
    const zoom = { zoomed: heading > ZOOMED_SCALE, percent: Math.round((heading / naturalScale) * 100) };
    if (zoom.zoomed !== zoomReport.zoomed || zoom.percent !== zoomReport.percent) {
      zoomReport = zoom;
      host.zoomChanged(zoom);
    }
  }

  function tick(now: number) {
    // Motion keeps its real duration when frames come slowly; only a long stall (a hidden tab) is cut short.
    const dt = clamp(now - lastFrame, 0, 100);
    lastFrame = now;
    let moving = false;
    for (const channel of channels) moving = advanceChannel(channel, dt) || moving;
    render();
    if (moving) {
      frame = requestAnimationFrame(tick);
      return;
    }
    frame = null;
    const callbacks = restCallbacks;
    restCallbacks = [];
    for (const callback of callbacks) callback();
  }

  function startLoop() {
    if (frame !== null) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function holdView(view: ViewTransform) {
    holdChannel(motion.scale, view.scale);
    holdChannel(motion.x, view.x);
    holdChannel(motion.y, view.y);
  }

  function springView(target: ViewTransform, spring: Spring, velocity?: Point) {
    if (prefersReducedMotion()) {
      holdView(target);
      render();
      return;
    }
    springChannel(motion.scale, target.scale, spring);
    springChannel(motion.x, target.x, spring, velocity?.x);
    springChannel(motion.y, target.y, spring, velocity?.y);
    startLoop();
  }

  function restingView(view: ViewTransform, anchor?: Point) {
    const settled = settleView(view, imageSize(), viewportSize(), maxZoom(naturalScale), anchor);
    return settled.scale <= ZOOMED_SCALE ? FIT_VIEW : settled;
  }

  /** A press can catch the view mid-animation; let go, it finishes the move to a resting place. */
  function settleStrayView() {
    const view = currentView();
    const target = restingView(view);
    if (target.scale !== view.scale || target.x !== view.x || target.y !== view.y) springView(target, ZOOM);
  }

  /** A press can also catch the slide between images; let go, it lands on the image in the middle. */
  function settleTrack() {
    if (motion.track.mode !== "rest" || motion.track.value === 0) return;
    springChannel(motion.track, 0, PAGE);
    startLoop();
  }

  function cancelTapTimer() {
    if (tapTimer !== null) clearTimeout(tapTimer);
    tapTimer = null;
  }

  function thumbnailRect(): { rect: CenteredRect; radius: number } | null {
    const { activeId, originFor } = host.state();
    const element = originFor?.(activeId);
    const viewport = host.viewport();
    if (!element || !viewport) return null;
    const box = element.getBoundingClientRect();
    const frameBox = viewport.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    // Scrolled out of sight: there is nothing to grow from or return to.
    if (box.bottom <= frameBox.top || box.top >= frameBox.bottom || box.right <= frameBox.left || box.left >= frameBox.right) return null;
    return {
      rect: {
        x: box.left + box.width / 2 - (frameBox.left + frameBox.width / 2),
        y: box.top + box.height / 2 - (frameBox.top + frameBox.height / 2),
        width: box.width,
        height: box.height,
      },
      radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0,
    };
  }

  function open() {
    opened = true;
    const reduced = prefersReducedMotion();
    const origin = !reduced && performance.now() - createdAt < OPEN_FROM_THUMBNAIL_MS ? thumbnailRect() : null;
    const size = imageSize();
    if (origin && size.width > 0 && size.height > 0) {
      const from = thumbnailView(origin.rect, size, origin.radius);
      crop = from.crop;
      holdView(from.view);
      holdChannel(motion.reveal, 1);
      holdChannel(motion.opacity, 1);
      springView(FIT_VIEW, OPEN);
      springChannel(motion.reveal, 0, OPEN);
    } else {
      if (!reduced) {
        holdChannel(motion.scale, 0.94);
        springChannel(motion.scale, 1, OPEN);
      }
      springChannel(motion.opacity, 1, FADE);
    }
    render();
    startLoop();
  }

  function finishClose() {
    if (closed) return;
    closed = true;
    if (closeTimer !== null) clearTimeout(closeTimer);
    host.state().onClose();
  }

  function requestClose(velocity: Point = { x: 0, y: 0 }) {
    if (closing) return;
    closing = true;
    host.closing();
    cancelTapTimer();
    gesture = { kind: "idle" };
    pointers.clear();
    const reduced = prefersReducedMotion();
    const origin = reduced ? null : thumbnailRect();
    const size = imageSize();
    const image = activeImage();
    if (origin && image?.complete && image.naturalWidth > 0 && size.width > 0) {
      // Back into the thumbnail it came from, carrying the hand's speed.
      const to = thumbnailView(origin.rect, size, origin.radius);
      crop = to.crop;
      springChannel(motion.reveal, 1, CLOSE);
      springChannel(motion.scale, to.view.scale, CLOSE, 0);
      springChannel(motion.x, to.view.x, CLOSE, velocity.x);
      springChannel(motion.y, to.view.y, CLOSE, velocity.y);
    } else {
      fadeOut = true;
      if (!reduced) {
        springChannel(motion.scale, motion.scale.value * 0.92, CLOSE, 0);
        // A throw keeps going the way it was thrown.
        if (velocity.y !== 0) springChannel(motion.y, motion.y.value + Math.sign(velocity.y) * viewportSize().height * 0.2, CLOSE, velocity.y);
      }
    }
    springChannel(motion.track, 0, PAGE);
    springChannel(motion.backdrop, 0, FADE);
    restCallbacks.push(finishClose);
    // A hidden tab paints no frames; the viewer still has to go.
    closeTimer = setTimeout(finishClose, 700);
    startLoop();
  }

  function navigate(direction: -1 | 1, velocity = 0) {
    if (closing) return;
    const { images, activeId, onActiveChange } = host.state();
    if (images.length < 2) {
      // Nothing further: a nudge says so.
      springChannel(motion.track, 0, PAGE, velocity || -direction * 1.2);
      startLoop();
      return;
    }
    // The owner has not shown the last step yet; one step at a time keeps the slide honest.
    if (pendingShift && performance.now() - pendingShift.time < 500) return;
    const index = Math.max(0, images.findIndex((image) => image.id === activeId));
    const next = images[(index + direction + images.length) % images.length];
    cancelTapTimer();
    pendingShift = { shift: direction, velocity, time: performance.now() };
    onActiveChange(next.id);
  }

  function resetOffscreen() {
    const { activeId } = host.state();
    for (const [id, image] of host.images) {
      if (id === activeId) continue;
      image.style.transform = "";
      image.style.opacity = "";
      image.style.clipPath = "";
    }
  }

  function activeChanged() {
    const { activeId } = host.state();
    if (activeId === shownId) return;
    shownId = activeId;
    const shift = pendingShift;
    pendingShift = null;
    cancelTapTimer();
    lastTap = null;
    gesture = { kind: "idle" };
    pointers.clear();
    // The incoming image starts fitted; the one leaving keeps its zoom until it is out of sight.
    opened = true;
    crop = null;
    holdView(FIT_VIEW);
    holdChannel(motion.opacity, 1);
    holdChannel(motion.reveal, 0);
    measureNaturalScale();
    if (!shift || prefersReducedMotion()) {
      holdChannel(motion.track, 0);
      resetOffscreen();
      render();
      return;
    }
    // The image that was beside the old one is now in the middle: shift the track by a page so nothing jumps.
    const width = pageWidth();
    const offset = clamp(motion.track.value + shift.shift * width, -width, width);
    holdChannel(motion.track, offset);
    // Keep the swipe's speed, short of carrying the image past the middle into the one beyond.
    springChannel(motion.track, 0, PAGE, landingVelocity(offset, 0, shift.velocity, PAGE));
    restCallbacks.push(resetOffscreen);
    render();
    startLoop();
  }

  function toggleZoom(anchor: Point) {
    springView(doubleTapView(currentView(), anchor, imageSize(), viewportSize(), naturalScale), ZOOM);
  }

  function zoomBy(factor: number) {
    if (closing) return;
    const base = headingView();
    springView(restingView(zoomAt(base, base.scale * factor, { x: 0, y: 0 })), ZOOM);
  }

  function toggleActualSize() {
    if (closing) return;
    const base = headingView();
    const actual = naturalScale;
    springView(Math.abs(base.scale - actual) < 0.01 ? FIT_VIEW : restingView(zoomAt(base, actual, { x: 0, y: 0 })), ZOOM);
  }

  function resetZoom() {
    if (!closing) springView(FIT_VIEW, ZOOM);
  }

  function beginPinch() {
    const entries = Array.from(pointers.entries()).slice(0, 2);
    if (entries.length < 2) return;
    const [[firstId, first], [secondId, second]] = entries;
    const anchor = midpoint(first, second);
    gesture = {
      kind: "pinch",
      ids: [firstId, secondId],
      startAnchor: anchor,
      anchor,
      startDistance: Math.max(1, distance(first, second)),
      from: currentView(),
      raw: motion.scale.value,
    };
  }

  function pointerDown(event: PointerEvent) {
    if (closing) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (pointers.size >= 2) return;
    const viewport = host.viewport();
    if (!viewport) return;
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    const point = local(event);
    pointers.set(event.pointerId, point);
    // Catch whatever is moving, exactly where it is on screen.
    holdView(currentView());
    holdChannel(motion.track);
    if (pointers.size === 1) {
      // Whatever this press turns out to be, the tap before it no longer closes the viewer.
      cancelTapTimer();
      gesture = {
        kind: "press",
        id: event.pointerId,
        start: point,
        time: event.timeStamp,
        pointerType: event.pointerType,
        onImage: event.target === activeImage(),
      };
      return;
    }
    // A second finger turns whatever one finger was doing into a pinch.
    if (gesture.kind === "swipe") {
      springChannel(motion.track, 0, PAGE);
      startLoop();
    }
    if (gesture.kind === "dismiss") {
      springChannel(motion.backdrop, 1, FADE);
      startLoop();
    }
    beginPinch();
  }

  function pointerMove(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    const point = local(event);
    pointers.set(event.pointerId, point);
    if (gesture.kind === "press") {
      if (event.pointerId !== gesture.id) return;
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      if (Math.hypot(dx, dy) < (gesture.pointerType === "mouse" ? 4 : 10)) return;
      cancelTapTimer();
      lastTap = null;
      const { id, start } = gesture;
      const samples: MotionSample[] = [{ ...start, time: gesture.time }];
      if (motion.scale.value > ZOOMED_SCALE) gesture = { kind: "pan", id, start, from: currentView(), samples };
      else if (Math.abs(dx) > Math.abs(dy)) gesture = { kind: "swipe", id, start, from: motion.track.value, samples };
      else gesture = { kind: "dismiss", id, start, from: currentView(), samples };
    }
    const time = event.timeStamp;
    switch (gesture.kind) {
      case "pan": {
        if (event.pointerId !== gesture.id) return;
        recordSample(gesture.samples, { ...point, time });
        const { from, start } = gesture;
        const next = elasticView({ scale: from.scale, x: from.x + point.x - start.x, y: from.y + point.y - start.y }, imageSize(), viewportSize());
        holdChannel(motion.x, next.x);
        holdChannel(motion.y, next.y);
        break;
      }
      case "swipe": {
        if (event.pointerId !== gesture.id) return;
        recordSample(gesture.samples, { ...point, time });
        const width = pageWidth();
        const offset = gesture.from + point.x - gesture.start.x;
        // Alone in the gallery, the image strains against both edges.
        holdChannel(motion.track, host.state().images.length > 1 ? clamp(offset, -width, width) : resist(offset, 0, 0, width));
        break;
      }
      case "dismiss": {
        if (event.pointerId !== gesture.id) return;
        recordSample(gesture.samples, { ...point, time });
        const dx = point.x - gesture.start.x;
        const dy = point.y - gesture.start.y;
        const progress = Math.min(1, Math.abs(dy) / Math.max(1, viewportSize().height));
        holdChannel(motion.x, gesture.from.x + dx);
        holdChannel(motion.y, gesture.from.y + dy);
        holdChannel(motion.scale, gesture.from.scale * (1 - 0.25 * progress));
        holdChannel(motion.backdrop, 1 - Math.min(1, progress * 2.2));
        break;
      }
      case "pinch": {
        const first = pointers.get(gesture.ids[0]);
        const second = pointers.get(gesture.ids[1]);
        if (!first || !second) return;
        gesture.raw = gesture.from.scale * (distance(first, second) / gesture.startDistance);
        gesture.anchor = midpoint(first, second);
        const scale = elasticScale(gesture.raw, maxZoom(naturalScale));
        holdView(elasticView(pinchView(gesture.from, gesture.startAnchor, gesture.anchor, scale), imageSize(), viewportSize()));
        break;
      }
      default:
        return;
    }
    render();
  }

  function endPan(velocity: Point, pinch?: Pinch) {
    if (pinch && pinch.from.scale <= ZOOMED_SCALE && pinch.raw < 0.75) {
      // Pinching a fitted image smaller puts it away.
      requestClose();
      return;
    }
    settleTrack();
    const scale = motion.scale.value;
    if (pinch || scale < 1 || scale > maxZoom(naturalScale)) {
      springView(restingView(currentView(), pinch?.anchor), EDGE, { x: 0, y: 0 });
      return;
    }
    const limits = panLimits(imageSize(), viewportSize(), scale);
    coastChannel(motion.x, -limits.x, limits.x, velocity.x, EDGE);
    coastChannel(motion.y, -limits.y, limits.y, velocity.y, EDGE);
    startLoop();
  }

  function endSwipe(velocity: number) {
    settleStrayView();
    const direction = host.state().images.length > 1 ? swipeDirection(motion.track.value, velocity, pageWidth()) : 0;
    if (direction === 0) {
      springChannel(motion.track, 0, PAGE, landingVelocity(motion.track.value, 0, velocity, PAGE));
      startLoop();
      return;
    }
    navigate(direction, velocity);
  }

  function endDismiss(from: ViewTransform, velocity: Point) {
    if (shouldDismiss(motion.y.value - from.y, velocity.y, viewportSize().height)) {
      requestClose(velocity);
      return;
    }
    springView(FIT_VIEW, RETURN, velocity);
    springChannel(motion.backdrop, 1, FADE);
    settleTrack();
    startLoop();
  }

  function tap(press: Extract<Gesture, { kind: "press" }>, point: Point, time: number) {
    settleStrayView();
    settleTrack();
    if (time - press.time > LONG_PRESS_MS) return;
    const previous = lastTap;
    if (
      press.pointerType !== "mouse" &&
      previous &&
      previous.pointerType === press.pointerType &&
      press.time - previous.time < DOUBLE_TAP_MS &&
      distance(previous.point, point) < DOUBLE_TAP_DISTANCE
    ) {
      lastTap = null;
      cancelTapTimer();
      toggleZoom(point);
      return;
    }
    lastTap = { time, point, pointerType: press.pointerType };
    const zoomed = motion.scale.value > ZOOMED_SCALE;
    if (press.pointerType === "mouse") {
      // A click on the picture zooms there; a click beside it backs out, one step at a time.
      if (press.onImage) toggleZoom(point);
      else if (zoomed) resetZoom();
      else requestClose();
      return;
    }
    if (!press.onImage) {
      if (zoomed) resetZoom();
      else requestClose();
      return;
    }
    if (zoomed) return;
    // A tap on the picture closes it, once it is clear the tap is not the first of two.
    cancelTapTimer();
    tapTimer = setTimeout(() => {
      tapTimer = null;
      requestClose();
    }, DOUBLE_TAP_MS);
  }

  function pointerUp(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    const point = local(event);
    pointers.delete(event.pointerId);
    const ended = gesture;
    const time = event.timeStamp;
    switch (ended.kind) {
      case "press":
        if (event.pointerId !== ended.id) return;
        gesture = { kind: "idle" };
        tap(ended, point, time);
        return;
      case "pan":
      case "swipe":
      case "dismiss": {
        if (event.pointerId !== ended.id) return;
        recordSample(ended.samples, { ...point, time });
        gesture = { kind: "idle" };
        const velocity = releaseVelocity(ended.samples);
        if (ended.kind === "pan") endPan(velocity, ended.pinch);
        else if (ended.kind === "swipe") endSwipe(velocity.x);
        else endDismiss(ended.from, velocity);
        return;
      }
      case "pinch": {
        // One finger lifted: the other carries on, panning from where it is.
        const remaining = Array.from(pointers.entries()).find(([id]) => ended.ids.includes(id));
        if (remaining) {
          const [id, start] = remaining;
          gesture = { kind: "pan", id, start, from: currentView(), samples: [{ ...start, time }], pinch: ended };
        } else {
          gesture = { kind: "idle" };
          endPan({ x: 0, y: 0 }, ended);
        }
        return;
      }
      default:
        return;
    }
  }

  function pointerCancel(event: PointerEvent) {
    if (!pointers.delete(event.pointerId)) return;
    pointers.clear();
    gesture = { kind: "idle" };
    if (closing) return;
    springChannel(motion.track, 0, PAGE);
    springChannel(motion.backdrop, 1, FADE);
    settleStrayView();
    startLoop();
  }

  function wheel(event: WheelEvent) {
    event.preventDefault();
    if (closing || pointers.size > 0) return;
    // Safari reports a trackpad pinch as gesture events; ignore any wheel echo of it.
    if (safariPinch && event.ctrlKey) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportSize().height : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    const base = headingView();
    if (!event.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
      // Sideways scrolling moves a zoomed picture; a fitted one has nowhere to go.
      if (base.scale <= ZOOMED_SCALE) return;
      const target = restingView({ ...base, x: base.x - dx });
      holdChannel(motion.x, target.x);
      holdChannel(motion.y, target.y);
      render();
      return;
    }
    if (dy === 0) return;
    const smooth = Math.abs(dy) < SMOOTH_WHEEL_DELTA;
    // Pinch steps are small and many; scale them up so the picture keeps pace with the fingers.
    const factor = Math.exp(-clamp(dy, -120, 120) * (event.ctrlKey && smooth ? 0.01 : 0.0025));
    const anchor = local(event);
    const target = settleView(zoomAt(base, base.scale * factor, anchor), imageSize(), viewportSize(), maxZoom(naturalScale), anchor);
    if (smooth) {
      holdView(target);
      render();
      return;
    }
    springView(target, WHEEL);
  }

  function safariGestureStart(event: SafariGestureEvent) {
    event.preventDefault();
    // iOS reports touch pinches here too; pointer events already carry those.
    if (closing || pointers.size > 0) return;
    safariPinch = { from: currentView(), anchor: local(event) };
  }

  function safariGestureChange(event: SafariGestureEvent) {
    event.preventDefault();
    if (!safariPinch || pointers.size > 0) return;
    const scale = elasticScale(safariPinch.from.scale * (event.scale ?? 1), maxZoom(naturalScale));
    holdView(elasticView(pinchView(safariPinch.from, safariPinch.anchor, local(event), scale), imageSize(), viewportSize()));
    render();
  }

  function safariGestureEnd(event: SafariGestureEvent) {
    event.preventDefault();
    if (!safariPinch) return;
    const anchor = local(event);
    safariPinch = null;
    springView(restingView(currentView(), anchor), EDGE, { x: 0, y: 0 });
  }

  function keyDown(event: KeyboardEvent) {
    if (closing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
    switch (event.key) {
      case "Escape":
        requestClose();
        break;
      case "ArrowLeft":
      case "ArrowRight":
        navigate(event.key === "ArrowLeft" ? -1 : 1);
        break;
      case "+":
      case "=":
        zoomBy(ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomBy(1 / ZOOM_STEP);
        break;
      case "0":
        resetZoom();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** The image now on screen has decoded and has its fitted size. */
  function imageReady(id: string) {
    if (id !== host.state().activeId) return;
    measureNaturalScale();
    if (!opened) open();
    else render();
  }

  function mounted() {
    springChannel(motion.backdrop, 1, FADE);
    render();
    startLoop();
  }

  function resized() {
    measureNaturalScale();
    if (closing || gesture.kind !== "idle" || motion.scale.mode !== "rest") return;
    holdView(restingView(currentView()));
    render();
  }

  function dispose() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    cancelTapTimer();
    if (closeTimer !== null) clearTimeout(closeTimer);
  }

  return {
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    wheel,
    safariGestureStart,
    safariGestureChange,
    safariGestureEnd,
    keyDown,
    navigate: (direction: -1 | 1) => navigate(direction),
    zoomBy,
    toggleActualSize,
    requestClose: () => requestClose(),
    imageReady,
    activeChanged,
    mounted,
    resized,
    dispose,
  };
}

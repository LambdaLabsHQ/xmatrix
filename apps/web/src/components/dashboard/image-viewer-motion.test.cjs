const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  FIT_VIEW,
  advanceChannel,
  coastChannel,
  createChannel,
  doubleTapView,
  landingVelocity,
  releaseVelocity,
  resist,
  settleView,
  shouldDismiss,
  springChannel,
  stepSpring,
  swipeDirection,
  thumbnailView,
  zoomAt,
} = require("./image-viewer-motion.ts");

const viewport = { width: 400, height: 800 };
const image = { width: 400, height: 300 };

/** The image pixel (from the image's centre, unscaled) shown at a viewport point. */
function imagePointAt(view, point) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

function run(channel, maxMs = 5000) {
  let elapsed = 0;
  const values = [];
  while (advanceChannel(channel, 16) && elapsed < maxMs) {
    elapsed += 16;
    values.push(channel.value);
  }
  return { elapsed, values };
}

test("zooming keeps the picture point under the cursor or fingers in place", () => {
  const view = { scale: 2, x: 30, y: -40 };
  const cursor = { x: 120, y: -75 };
  const zoomed = zoomAt(view, 5, cursor);
  assert.deepEqual(imagePointAt(zoomed, cursor), imagePointAt(view, cursor));
  assert.equal(zoomed.scale, 5);
});

test("a settled view leaves no gap between an image edge and the viewport", () => {
  // At 2x the 400x300 image is 800x600: 200px of travel each way across, none down the 800px-tall viewport.
  assert.deepEqual(settleView({ scale: 2, x: 500, y: 90 }, image, viewport, 8), { scale: 2, x: 200, y: 0 });
  assert.deepEqual(settleView({ scale: 2, x: -500, y: -90 }, image, viewport, 8), { scale: 2, x: -200, y: 0 });
  // Pinched smaller than fit, it comes back to fit.
  assert.deepEqual(settleView({ scale: 0.6, x: 40, y: 25 }, image, viewport, 8), FIT_VIEW);
  // Pinched past the deepest zoom, it returns to it around the fingers.
  const anchor = { x: 50, y: 20 };
  const over = { scale: 10, x: 0, y: 0 };
  const settled = settleView(over, image, viewport, 8, anchor);
  assert.equal(settled.scale, 8);
  assert.deepEqual(imagePointAt(settled, anchor), imagePointAt(over, anchor));
});

test("past an edge a drag keeps moving but strains more the further it goes", () => {
  const limit = 100;
  const followed = [120, 200, 400, 1600].map((value) => resist(value, -limit, limit, 400));
  for (let index = 0; index < followed.length; index += 1) {
    assert.ok(followed[index] > limit, "it does move past the edge");
    assert.ok(followed[index] - limit < [20, 100, 300, 1500][index], "but less than the finger");
    if (index > 0) assert.ok(followed[index] > followed[index - 1], "and never backwards");
  }
  assert.ok(followed[3] - limit < 400, "however hard it is pulled, it stays within a viewport of the edge");
  assert.equal(resist(-40, -limit, limit, 400), -40, "inside the limits it follows 1:1");
});

test("a released swipe pages by where its momentum carries it, never more than one image", () => {
  const page = 424;
  assert.equal(swipeDirection(-60, 0, page), 0, "a short slow drag snaps back");
  assert.equal(swipeDirection(-250, 0, page), 1, "past halfway it goes on to the next image");
  assert.equal(swipeDirection(250, 0, page), -1, "the other way, the previous one");
  assert.equal(swipeDirection(-40, -1.5, page), 1, "a short fast flick pages");
  assert.equal(swipeDirection(-400, -9, page), 1, "however fast, one image at a time");
  assert.equal(swipeDirection(-300, 1.2, page), 0, "a flick back against the drag returns to the start, not past it");
  assert.equal(swipeDirection(-5, 1.2, page), -1, "a flick that starts with a wobble the other way still counts");
  // Caught while the last step was still sliding in from the right, then flicked left.
  assert.equal(swipeDirection(100, -2, page), 1, "a flick pages on from the image on screen, wherever the slide was caught");
  assert.equal(swipeDirection(-190, -0.1, page), 1, "nearly halfway and still moving carries on to the next image");
  assert.equal(swipeDirection(-190, 0, page), 0, "nearly halfway and stopped goes back");
});

test("a page landing keeps the swipe's speed unless that would carry it past the middle", () => {
  const spring = { response: 380, damping: 1 };
  assert.equal(landingVelocity(400, 0, -2, spring), -2, "an ordinary flick keeps its speed");
  const capped = landingVelocity(400, 0, -40, spring);
  const channel = createChannel(400, 0.5);
  springChannel(channel, 0, spring, capped);
  const { values } = run(channel);
  assert.ok(values.every((value) => value >= -0.5), "bunched-up input never flings the image past the middle");
  assert.equal(channel.value, 0);
});

test("a drag down closes when thrown or pulled far enough, not when flicked back", () => {
  assert.equal(shouldDismiss(60, 0, 800), false);
  assert.equal(shouldDismiss(220, 0, 800), true);
  assert.equal(shouldDismiss(60, 1, 800), true, "a quick throw closes from a short drag");
  assert.equal(shouldDismiss(-60, -1, 800), true, "upwards too");
  assert.equal(shouldDismiss(220, -1.5, 800), false, "flicked back, it stays open");
});

test("release velocity reads the last 100ms, so a pause before lifting is a still release", () => {
  const moving = [
    { x: 0, y: 0, time: 0 },
    { x: 40, y: 0, time: 40 },
    { x: 100, y: 10, time: 100 },
  ];
  assert.deepEqual(releaseVelocity(moving), { x: 1, y: 0.1 });
  const paused = [...moving, { x: 100, y: 10, time: 400 }];
  assert.deepEqual(releaseVelocity(paused), { x: 0, y: 0 });
  const bunched = [{ x: 0, y: 0, time: 0 }, { x: 300, y: 0, time: 2 }];
  assert.deepEqual(releaseVelocity(bunched), { x: 8, y: 0 }, "events delivered in a burst are capped at a hand's speed");
  const sameInstant = [{ x: 0, y: 0, time: 5 }, { x: -120, y: 0, time: 5 }];
  assert.deepEqual(releaseVelocity(sameInstant), { x: -8, y: 0 }, "movement with no time between events is a fast flick, not a still release");
  assert.deepEqual(releaseVelocity([{ x: 3, y: 4, time: 5 }, { x: 4, y: 3, time: 5 }]), { x: 0, y: 0 }, "a pixel of jitter at lift is still");
});

test("a critically damped spring lands on its target without overshoot", () => {
  const channel = createChannel(0, 0.5);
  springChannel(channel, 300, { response: 380, damping: 1 });
  const { values, elapsed } = run(channel);
  assert.ok(values.every((value) => value <= 300), "never past the target");
  assert.ok(values.every((value, index) => index === 0 || value >= values[index - 1]), "never back and forth");
  assert.equal(channel.value, 300, "at rest exactly on the target");
  assert.equal(channel.mode, "rest");
  assert.ok(elapsed < 1000, "and settles promptly");
});

test("a spring takes over at the hand's speed, so letting go has no seam", () => {
  // Released at 2px/ms moving away from the target: the first instant still moves at 2px/ms.
  const next = stepSpring({ value: 0, velocity: 2 }, -100, 0.001, { response: 380, damping: 1 });
  assert.ok(Math.abs(next.velocity - 2) < 0.01);
  // Then it turns around and still settles on the target.
  const channel = createChannel(0, 0.5);
  springChannel(channel, -100, { response: 380, damping: 1 }, 2);
  const { values } = run(channel);
  assert.ok(Math.max(...values) > 0, "it carries on the way it was thrown first");
  assert.equal(channel.value, -100);
});

test("an underdamped spring overshoots a little and still settles", () => {
  const channel = createChannel(0, 0.5);
  springChannel(channel, 100, { response: 380, damping: 0.86 });
  const { values } = run(channel);
  const peak = Math.max(...values);
  assert.ok(peak > 100 && peak < 110);
  assert.equal(channel.value, 100);
});

test("a pan coasts to a stop inside its bounds, and springs back after hitting one", () => {
  const edge = { response: 420, damping: 1 };
  const gentle = createChannel(0, 0.5);
  coastChannel(gentle, -200, 200, 0.3, edge);
  run(gentle);
  assert.ok(gentle.value > 50 && gentle.value < 200, `glides on and stops at ${gentle.value}`);

  const hard = createChannel(150, 0.5);
  coastChannel(hard, -200, 200, 3, edge);
  const { values } = run(hard);
  assert.ok(Math.max(...values) > 200, "momentum carries it past the edge");
  assert.ok(Math.max(...values) < 300, "only a little");
  assert.equal(hard.value, 200, "and it comes back to rest on the edge");
});

test("an image opening from a thumbnail covers it exactly as object-fit: cover crops it", () => {
  const thumbnail = { x: -100, y: 250, width: 120, height: 120 };
  const { view, crop } = thumbnailView(thumbnail, image, 12);
  // The 400x300 image scales so its shorter side fills the thumbnail: 120 / 300.
  assert.equal(view.scale, 0.4);
  assert.deepEqual({ x: view.x, y: view.y }, { x: -100, y: 250 });
  // What the crop leaves visible, scaled and placed, is the thumbnail's box.
  const visibleWidth = (image.width - crop.x * 2) * view.scale;
  const visibleHeight = (image.height - crop.y * 2) * view.scale;
  assert.ok(Math.abs(visibleWidth - 120) < 1e-9);
  assert.ok(Math.abs(visibleHeight - 120) < 1e-9);
  assert.equal(crop.radius * view.scale, 12, "with the thumbnail's own corners");
});

test("double tap zooms around the tap to legible pixels, at least 2x, and back to fit", () => {
  const tap = { x: 60, y: 10 };
  const small = doubleTapView(FIT_VIEW, tap, image, viewport, 1);
  assert.equal(small.scale, 2, "a picture already at its own size still zooms 2x");
  const screenshot = doubleTapView(FIT_VIEW, tap, image, viewport, 3);
  assert.equal(screenshot.scale, 3, "a large screenshot zooms to its own pixels");
  assert.deepEqual(imagePointAt(screenshot, tap), imagePointAt(FIT_VIEW, tap), "the tapped point stays put");
  assert.equal(doubleTapView(FIT_VIEW, tap, image, viewport, 12).scale, 4, "but never by a giant jump");
  assert.deepEqual(doubleTapView(screenshot, tap, image, viewport, 3), FIT_VIEW);
});

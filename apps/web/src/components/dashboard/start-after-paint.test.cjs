const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();

/** A page whose frames run when the test says, at the times it says. */
function fakeFrames() {
  let clock = 0;
  let queued = [];
  globalThis.performance = { now: () => clock };
  globalThis.requestAnimationFrame = (callback) => queued.push(callback);
  return {
    /** A frame whose callbacks start `afterMs` after the last, then keep the main thread `busyMs`. */
    frame(afterMs, busyMs = 0) {
      clock += afterMs;
      const running = queued;
      queued = [];
      for (const callback of running) callback(clock);
      clock += busyMs;
    },
  };
}

function heldAnimation() {
  const animation = {
    playState: "running",
    pause() { animation.playState = "paused"; },
    play() { animation.playState = "running"; },
    cancel() { animation.playState = "idle"; },
  };
  return animation;
}

function load() {
  delete require.cache[require.resolve("./start-after-paint.ts")];
  return require("./start-after-paint.ts").startAfterPaint;
}

test("a push held over a quiet page starts on the frame after the one that paints it", () => {
  const frames = fakeFrames();
  const startAfterPaint = load();
  const push = heldAnimation();
  startAfterPaint([push]);
  assert.equal(push.playState, "paused");
  frames.frame(16);
  assert.equal(push.playState, "paused");
  frames.frame(16);
  assert.equal(push.playState, "running");
});

test("a push waits out the busy frames after its screen renders, and starts on the first on time", () => {
  const frames = fakeFrames();
  const startAfterPaint = load();
  const push = heldAnimation();
  startAfterPaint([push]);
  frames.frame(16, 60);
  frames.frame(16, 60);
  frames.frame(16, 60);
  assert.equal(push.playState, "paused");
  // The frame after the last busy one came late, so it still had work in it.
  frames.frame(16);
  assert.equal(push.playState, "paused");
  frames.frame(16);
  assert.equal(push.playState, "running");
});

test("a main thread that never goes quiet holds a push no longer than the cap", () => {
  const frames = fakeFrames();
  const startAfterPaint = load();
  const push = heldAnimation();
  startAfterPaint([push]);
  let frame = 0;
  while (push.playState === "paused" && frame < 20) {
    frames.frame(16, 80);
    frame += 1;
  }
  assert.equal(push.playState, "running");
  assert.ok(frame <= 4, `held for ${frame} frames`);
});

test("parts of one change held from different places start on the same frame", () => {
  const frames = fakeFrames();
  const startAfterPaint = load();
  const track = heldAnimation();
  const bar = heldAnimation();
  startAfterPaint([track]);
  frames.frame(16, 60);
  startAfterPaint([bar, null]);
  frames.frame(16);
  assert.deepEqual([track.playState, bar.playState], ["paused", "paused"]);
  frames.frame(16);
  assert.deepEqual([track.playState, bar.playState], ["running", "running"]);
});

test("an animation cancelled while held stays cancelled", () => {
  const frames = fakeFrames();
  const startAfterPaint = load();
  const push = heldAnimation();
  startAfterPaint([push]);
  push.cancel();
  frames.frame(16);
  frames.frame(16);
  assert.equal(push.playState, "idle");
});

test("a change built on the quiet frame starts there with what was held, and one put away meanwhile does not", () => {
  const frames = fakeFrames();
  const { startAfterPaint, whenQuiet } = (() => {
    delete require.cache[require.resolve("./start-after-paint.ts")];
    return require("./start-after-paint.ts");
  })();
  const bar = heldAnimation();
  const built = [];
  startAfterPaint([bar]);
  whenQuiet(() => built.push(bar.playState));
  const putAway = whenQuiet(() => built.push("put away"));
  frames.frame(16, 60);
  putAway();
  frames.frame(16);
  assert.deepEqual(built, []);
  frames.frame(16);
  assert.deepEqual(built, ["running"]);
});

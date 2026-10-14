const assert = require("node:assert/strict");
const test = require("node:test");

require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { NO_ANIMATION_ITERATION_EVENTS_SCRIPT } = require("./animation-iteration-events.ts");

test("no listener for an animation's turns is registered, and every other listener is", () => {
  const registered = EventTarget.prototype.addEventListener;
  try {
    new Function(NO_ANIMATION_ITERATION_EVENTS_SCRIPT)();
    const target = new EventTarget();
    const heard = [];
    for (const type of ["animationiteration", "webkitAnimationIteration", "animationstart", "animationend"]) {
      target.addEventListener(type, (event) => heard.push(event.type));
    }
    // A listener's options still reach the browser: this one hears the first event only.
    target.addEventListener("animationend", () => heard.push("once"), { once: true });
    for (const type of ["animationstart", "animationiteration", "webkitAnimationIteration", "animationend", "animationend"]) {
      target.dispatchEvent(new Event(type));
    }
    assert.deepEqual(heard, ["animationstart", "animationend", "once", "animationend"]);
  } finally {
    EventTarget.prototype.addEventListener = registered;
  }
});

/**
 * Run by the root layout before React attaches its listeners.
 *
 * React listens on its root for every event it knows, `animationiteration`
 * among them, and nothing in the app handles that one. Chromium takes a
 * listener anywhere in the document to mean that every looping CSS animation
 * owes an event at each turn: it wakes the main thread ahead of every loop of
 * every pulsing dot, ring and shimmer and restyles all of them, frame after
 * frame, until the turn has passed, though they run on the compositor. On an
 * idle page with working Agents in view that was half of what the thread did.
 *
 * With no listener registered a loop owes the main thread nothing. Whatever
 * comes to need an animation's turns reads the animation's own time.
 */
export const NO_ANIMATION_ITERATION_EVENTS_SCRIPT = `
  (() => {
    const listen = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === "animationiteration" || type === "webkitAnimationIteration") return;
      return listen.call(this, type, listener, options);
    };
  })();
`;

/**
 * The window of a frame, for tests of the app packaged in the Chrome
 * extension: `ancestor` frames a page at `origin`, and `dispatch` delivers a
 * message event to the frame. The parent records what the frame posts to it.
 */
function frameWindow(ancestor, origin = ancestor) {
  const listeners = new Set();
  const parent = { posted: [], postMessage(message, target) { this.posted.push({ message, origin: target }); } };
  return {
    parent,
    location: { ancestorOrigins: [ancestor], href: `${origin}/app/index.html`, origin },
    addEventListener: (type, listener) => type === "message" && listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    dispatch: (event) => { for (const listener of Array.from(listeners)) listener(event); },
  };
}

module.exports = { frameWindow };

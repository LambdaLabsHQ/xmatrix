const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { isBrowserNotice, isClientDisconnect, isStaleBuild } = require("./error-noise.ts");

test("a stale build is recognised from a failed chunk fetch or a module webpack no longer has", () => {
  const chunk = Object.assign(new Error("Loading chunk 925 failed."), { name: "ChunkLoadError" });
  assert.equal(isStaleBuild(chunk), true);
  const missing = new TypeError("Cannot read properties of undefined (reading 'call')");
  missing.stack = `${missing.message}\n    at r (https://xmatrix.sh/_next/static/chunks/webpack-3f1c.js:1:123)`;
  assert.equal(isStaleBuild(missing), true);
  const ours = new TypeError("Cannot read properties of undefined (reading 'call')");
  ours.stack = `${ours.message}\n    at send (https://xmatrix.sh/_next/static/chunks/app/page-1.js:3:9)`;
  assert.equal(isStaleBuild(ours), false, "the same TypeError in our own code is a real failure");
  assert.equal(isStaleBuild("Loading chunk 1 failed"), false);
});

test("ResizeObserver's dropped layout pass is a browser notice, not a page failure", () => {
  assert.equal(isBrowserNotice(new Error("ResizeObserver loop limit exceeded")), true);
  assert.equal(isBrowserNotice("ResizeObserver loop completed with undelivered notifications."), true);
  assert.equal(isBrowserNotice(new Error("Cannot render ResizeObserver panel")), false);
});

test("only a response the visitor stopped reading counts as a disconnect", () => {
  assert.equal(isClientDisconnect(new Error("failed to pipe response", { cause: new Error("Network connection lost.") })), true);
  assert.equal(isClientDisconnect(new Error("failed to pipe response", { cause: new Error("render failed") })), false);
  assert.equal(isClientDisconnect(new Error("failed to pipe response")), false);
});

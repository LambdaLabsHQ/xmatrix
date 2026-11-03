const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();

// The mobile-push reporter owns this boundary. Navigation tests already cover
// when a push runs; they do not observe Sentry or its once-per-page allowance.
test("desktop declines do not report or consume the first mobile push diagnostic", async (t) => {
  const sentry = require("@sentry/browser");
  const captured = t.mock.method(sentry, "captureMessage", () => undefined);
  const modulePath = require.resolve("./use-mobile-list-transition.ts");
  delete require.cache[modulePath];
  const { reportPushDeclined } = require(modulePath);
  t.after(() => delete require.cache[modulePath]);
  const desktop = { isMobileViewport: false, mobileDockPager: false, view: "messages", client: "web" };
  reportPushDeclined("the list was not free to push from", () => desktop);
  await new Promise(setImmediate);
  assert.equal(captured.mock.callCount(), 0, "a desktop has no mobile push to lose");

  // Resizing the same page into a phone must retain the one useful report.
  const phone = { ...desktop, isMobileViewport: true, mobileDockPager: true };
  reportPushDeclined("the list was not free to push from", () => phone);
  await new Promise(setImmediate);
  assert.deepEqual(captured.mock.calls.map(call => call.arguments), [[
    "Conversation push did not run: the list was not free to push from", { level: "warning", extra: phone },
  ]]);
  reportPushDeclined("no list transition was mounted", () => ({ isMobileViewport: true, client: "ios" }));
  await new Promise(setImmediate);
  assert.equal(captured.mock.callCount(), 1, "the mobile diagnostic stays bounded to one per page");
});

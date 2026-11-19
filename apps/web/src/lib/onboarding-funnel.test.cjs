const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { classifyOnboardingDevice } = require("./onboarding-funnel.ts");

// Protects the onboarding device boundary: mobile native apps inject
// window.xmatrixDesktop too and must not masquerade as desktop_app, while a
// narrow split-screen desktop browser stays desktop_web so it keeps its
// download button and setup command.
test("iOS and Android native bridges classify as phone, desktop bridges as desktop_app", () => {
  assert.equal(classifyOnboardingDevice({ bridge: { client: "ios", platform: "ios" }, narrowViewport: false }), "phone");
  assert.equal(classifyOnboardingDevice({ bridge: { client: "android", platform: "android" }, narrowViewport: false }), "phone");
  assert.equal(classifyOnboardingDevice({ bridge: { platform: "ios" }, narrowViewport: false }), "phone");
  assert.equal(classifyOnboardingDevice({ bridge: { client: "desktop", platform: "darwin" }, narrowViewport: true }), "desktop_app");
  assert.equal(classifyOnboardingDevice({ bridge: { client: "desktop", platform: "win32" }, narrowViewport: false }), "desktop_app");
});

test("a narrow desktop browser window stays desktop_web; mobile browsers and touch viewports stay phone", () => {
  const macChrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
  assert.equal(classifyOnboardingDevice({
    userAgent: macChrome, platform: "MacIntel", maxTouchPoints: 0, narrowViewport: true, coarsePointer: false,
  }), "desktop_web");
  assert.equal(classifyOnboardingDevice({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15",
    platform: "iPhone", maxTouchPoints: 5, narrowViewport: false, coarsePointer: true,
  }), "phone");
  assert.equal(classifyOnboardingDevice({
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l", maxTouchPoints: 5, narrowViewport: false, coarsePointer: true,
  }), "phone");
  // iPadOS requesting a desktop user agent still reports MacIntel with multi-touch.
  assert.equal(classifyOnboardingDevice({
    userAgent: macChrome, platform: "MacIntel", maxTouchPoints: 5, narrowViewport: false, coarsePointer: true,
  }), "phone");
  // Touch-screen Windows laptops (e.g. Surface) keep desktop_web in a narrow window.
  const windowsEdge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0";
  assert.equal(classifyOnboardingDevice({
    userAgent: windowsEdge, platform: "Win32", maxTouchPoints: 10, narrowViewport: true, coarsePointer: false,
  }), "desktop_web");
  assert.equal(classifyOnboardingDevice({
    userAgent: windowsEdge, platform: "Win32", maxTouchPoints: 10, narrowViewport: true, coarsePointer: true,
  }), "desktop_web");
  // Touch-screen Linux laptop with a fine pointer in a narrow window stays desktop_web.
  assert.equal(classifyOnboardingDevice({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    platform: "Linux x86_64", maxTouchPoints: 10, narrowViewport: true, coarsePointer: false,
  }), "desktop_web");
  // Emulated mobile viewport with touch (e.g. Playwright mobile context).
  assert.equal(classifyOnboardingDevice({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    platform: "Linux x86_64", maxTouchPoints: 1, narrowViewport: true, coarsePointer: true,
  }), "phone");
});
